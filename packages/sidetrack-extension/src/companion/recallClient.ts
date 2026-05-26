import type { CompanionSettings, Problem } from './model';

export interface RecallTurnInput {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseProblemMessage = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const problem = value as Partial<Problem>;
  return typeof problem.detail === 'string'
    ? problem.detail
    : typeof problem.title === 'string'
      ? problem.title
      : undefined;
};

export class RecallClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async indexTurn(item: RecallTurnInput): Promise<void> {
    await this.indexTurns([item]);
  }

  // Batched variant — used by the capture flow to push every turn
  // of a multi-turn capture event in one request. The companion's
  // /v1/recall/index endpoint already accepts an `items[]` array
  // and embeds them in batches internally, so this is just the
  // client surface that was missing. Without this, sendToCompanion
  // could only push one turn per capture and 90% of the index drift
  // came from un-indexed earlier turns waiting for a full rebuild.
  async indexTurns(items: readonly RecallTurnInput[]): Promise<void> {
    if (items.length === 0) return;
    const response = await fetch(`${this.baseUrl}/recall/index`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
      },
      body: JSON.stringify({ items }),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
  }

  async query(
    q: string,
    opts: { readonly limit?: number; readonly workstreamId?: string } = {},
  ): Promise<readonly RankedItem[]> {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.workstreamId !== undefined) params.set('workstreamId', opts.workstreamId);
    const response = await fetch(`${this.baseUrl}/recall/query?${params.toString()}`, {
      method: 'GET',
      headers: { 'x-bac-bridge-key': this.settings.bridgeKey },
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { readonly data?: unknown };
    if (!Array.isArray(body.data)) return [];
    return body.data.filter((item: unknown): item is RankedItem => isRankedItem(item));
  }
}

export interface RankedItem {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly score: number;
  readonly title?: string;
  readonly snippet?: string;
  // Canonical URL of the source thread, populated by the companion
  // from the thread JSON. Used for: dedup across stale duplicate
  // bac_ids that point at the same chat URL (common after a
  // re-capture before the bac_id-stability fix), filtering out the
  // current page in the side panel proxy, and giving "Jump" a real
  // target instead of the current page URL.
  readonly threadUrl?: string;
}

const isRankedItem = (value: unknown): value is RankedItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.threadId === 'string' &&
  typeof value.capturedAt === 'string' &&
  typeof value.score === 'number';

export const createRecallClient = (settings: CompanionSettings): RecallClient =>
  new RecallClient(settings);

// FU1 — module-level coalescer for indexTurns calls. Multiple
// capture events firing close together (e.g. user opens several
// chat tabs in quick succession, or sync replay) used to each post
// a separate /v1/recall/index request. With the server-side
// batching fix (PR #221) the per-request cost is now ~400ms even
// at 50 items, so the urgency is low — but a tiny client-side
// debounce still helps: it collapses N events within
// COALESCE_WINDOW_MS into a single POST, halving the embedder
// warm-up cost (which fires per request) and freeing the bridge
// for status polls.
//
// Trade-off: indexing latency grows by COALESCE_WINDOW_MS in the
// uncontested case. 200ms is well below human "did my capture
// land" perception, and the existing capture pipeline already
// takes longer than that to extract + write.
const COALESCE_WINDOW_MS = 200;
type Pending = {
  readonly items: RecallTurnInput[];
  readonly resolves: ((value: void) => void)[];
  readonly rejects: ((reason: unknown) => void)[];
  timer: ReturnType<typeof setTimeout> | null;
};
const pendingByBridge = new Map<string, Pending>();

const bridgeKeyFor = (settings: CompanionSettings): string =>
  `${String(settings.port)}::${settings.bridgeKey}`;

const flushPending = (settings: CompanionSettings): void => {
  const key = bridgeKeyFor(settings);
  const pending = pendingByBridge.get(key);
  if (pending === undefined) return;
  pendingByBridge.delete(key);
  pending.timer = null;
  const { items, resolves, rejects } = pending;
  if (items.length === 0) {
    for (const resolve of resolves) resolve();
    return;
  }
  const client = createRecallClient(settings);
  client.indexTurns(items).then(
    () => {
      for (const resolve of resolves) resolve();
    },
    (err: unknown) => {
      for (const reject of rejects) reject(err);
    },
  );
};

/** Coalescing wrapper around RecallClient.indexTurns. Multiple calls
 *  within COALESCE_WINDOW_MS collapse into a single POST. Returns a
 *  promise that resolves when the underlying POST completes. */
export const indexTurnsCoalesced = (
  settings: CompanionSettings,
  items: readonly RecallTurnInput[],
): Promise<void> => {
  if (items.length === 0) return Promise.resolve();
  const key = bridgeKeyFor(settings);
  return new Promise<void>((resolve, reject) => {
    let pending = pendingByBridge.get(key);
    if (pending === undefined) {
      pending = { items: [], resolves: [], rejects: [], timer: null };
      pendingByBridge.set(key, pending);
    }
    pending.items.push(...items);
    pending.resolves.push(resolve);
    pending.rejects.push(reject);
    if (pending.timer === null) {
      pending.timer = setTimeout(() => {
        flushPending(settings);
      }, COALESCE_WINDOW_MS);
    }
  });
};
