import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';

// Layer 3 — multi-flow user-story HTTP integration.
//
// Spawns a real companion process, seeds the three woven flows by
// POSTing events through the same HTTP routes the extension uses
// (workstreams / threads / events / dispatches / annotations / queue
// / coding-sessions / reminders / timeline events), then GETs
// /v1/connections/nodes/{anchorId}/neighbors?hops=2 for each anchor
// and asserts that parallel-flow separation works at the live HTTP
// surface.
//
// Browser-free: no extension runtime, no Chrome — just node-fetch
// against the companion's bridge-key-authed routes. The unit-level
// reducer test (companion package) and render-level test (extension
// package) cover the in-process layers; this spec proves the full
// HTTP path from event ingest through `subgraphForNode` matches.

// ---------------------------------------------------------------------------
// Shared URLs / ids — kept in sync with the companion fixture.
// ---------------------------------------------------------------------------

const URL_HN_COPYFAIL = 'https://news.ycombinator.com/item?id=42_copyfail';
const URL_XINT_BLOG = 'https://xint.io/blog/copy-fail-linux-distributions';
const URL_GOOGLE_CVE = 'https://www.google.com/search?q=linux+copy_file_range+CVE';
const URL_KERNEL_DOC = 'https://kernel.org/doc/man-pages/online/copy_file_range.2.html';
const URL_NVD_CVE = 'https://nvd.nist.gov/vuln/detail/CVE-2024-12345';
const URL_CLAUDE_CVE = 'https://claude.ai/chat/cve_thread';
const URL_CHATGPT_CVE = 'https://chatgpt.com/c/cve_review';

const URL_HN_PGMERGE = 'https://news.ycombinator.com/item?id=42_pgmerge';
const URL_PG_BLOG = 'https://blog.example.com/merge-pitfalls';
const URL_PG_DOCS = 'https://www.postgresql.org/docs/current/sql-merge.html';
const URL_CLAUDE_PG = 'https://claude.ai/chat/pg_thread';
const URL_CHATGPT_PG = 'https://chatgpt.com/c/pg_review';

const URL_GH_PR = 'https://github.com/sidetrack-co/sidetrack/pull/98';
const URL_GH_BRAINSTORM = 'https://github.com/sidetrack-co/sidetrack/blob/main/BRAINSTORM.md';
const URL_CLAUDE_SB = 'https://claude.ai/chat/sb_thread';
const URL_CHATGPT_SB = 'https://chatgpt.com/c/sb_review';

const WS_RESEARCH = 'ws_research';
const WS_SECURITY = 'ws_security';
const WS_POSTGRES = 'ws_postgres';
const WS_SIDETRACK = 'ws_sidetrack';

const T_CVE_CLAUDE = 't_cve_claude';
const T_CVE_CHATGPT = 't_cve_chatgpt';
const T_PG_CLAUDE = 't_pg_claude';
const T_PG_CHATGPT = 't_pg_chatgpt';
const T_SB_CLAUDE = 't_sb_claude';
const T_SB_CHATGPT = 't_sb_chatgpt';

const PYTHON_REPRO_BLOCK =
  'import os\nfd = os.open("/tmp/probe", os.O_RDONLY)\ndata = os.copy_file_range(fd, fd2, 4096, 0)';
const SQL_MERGE_BLOCK =
  'MERGE INTO accounts a USING new_balances n ON a.id = n.id WHEN MATCHED THEN UPDATE SET balance=n.balance';
const REDUCER_TS_BLOCK =
  'export const buildConnectionsSnapshot = (input: ConnectionsInput): ConnectionsSnapshot => {';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const apiPost = async (
  comp: TestCompanion,
  path: string,
  body: unknown,
): Promise<unknown> => {
  const url = `http://127.0.0.1:${String(comp.port)}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': comp.bridgeKey,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} → ${String(response.status)}: ${text}`);
  }
  if (text.length === 0) return undefined;
  return JSON.parse(text);
};

const apiGet = async (comp: TestCompanion, path: string): Promise<unknown> => {
  const url = `http://127.0.0.1:${String(comp.port)}${path}`;
  const response = await fetch(url, {
    headers: { 'x-bac-bridge-key': comp.bridgeKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} → ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text);
};

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

interface MutationResult {
  data: { bac_id: string };
}

const seedWorkstream = async (
  comp: TestCompanion,
  title: string,
  parentId?: string,
): Promise<string> => {
  const result = (await apiPost(comp, '/v1/workstreams', {
    title,
    ...(parentId !== undefined ? { parentId } : {}),
  })) as MutationResult;
  return result.data.bac_id;
};

const seedThread = async (
  comp: TestCompanion,
  input: {
    bac_id: string;
    provider: 'claude' | 'chatgpt';
    threadUrl: string;
    title: string;
    primaryWorkstreamId: string;
    lastSeenAt: string;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/threads', {
    bac_id: input.bac_id,
    provider: input.provider,
    threadUrl: input.threadUrl,
    title: input.title,
    lastSeenAt: input.lastSeenAt,
    status: 'active',
    trackingMode: 'auto',
    primaryWorkstreamId: input.primaryWorkstreamId,
    tags: [],
  });
};

const seedCapture = async (
  comp: TestCompanion,
  input: {
    threadId: string;
    threadUrl: string;
    provider: 'claude' | 'chatgpt';
    title: string;
    capturedAt: string;
    turns: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/events', {
    threadId: input.threadId,
    threadUrl: input.threadUrl,
    provider: input.provider,
    title: input.title,
    capturedAt: input.capturedAt,
    turns: input.turns.map((t, i) => ({
      ordinal: i,
      role: t.role,
      text: t.text,
      capturedAt: input.capturedAt,
    })),
  });
};

const seedDispatch = async (
  comp: TestCompanion,
  input: {
    bac_id: string;
    title: string;
    target: { provider: string };
    workstreamId: string;
    sourceThreadId: string;
    body: string;
    createdAt: string;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/dispatches', {
    ...input,
    kind: 'coding',
    target: { ...input.target, mode: 'paste' },
  });
};

const seedQueue = async (
  comp: TestCompanion,
  input: {
    bac_id: string;
    text: string;
    scope: 'thread' | 'workstream';
    targetId: string;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/queue', { ...input, status: 'pending' });
};

const seedAnnotation = async (
  comp: TestCompanion,
  input: {
    bac_id: string;
    url: string;
    note: string;
    pageTitle: string;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/annotations', {
    bac_id: input.bac_id,
    url: input.url,
    note: input.note,
    pageTitle: input.pageTitle,
    anchor: {
      textQuote: { exact: 'placeholder', prefix: '', suffix: '' },
      textPosition: { start: 0, end: 11 },
      cssSelector: 'body',
    },
  });
};

const seedTimelineVisits = async (
  comp: TestCompanion,
  visits: ReadonlyArray<{ url: string; observedAt: string; title: string; workstreamId?: string }>,
): Promise<void> => {
  // /v1/timeline/events expects full AcceptedEvent shapes. Synthesize
  // a deterministic replicaId + monotonic seq per visit so the
  // companion's importEdgeEvent dedupes correctly.
  const replicaId = 'replica-multiflow-test';
  await apiPost(comp, '/v1/timeline/events', {
    events: visits.map((v, i) => ({
      clientEventId: `tl-${String(i + 1).padStart(3, '0')}`,
      dot: { replicaId, seq: i + 1 },
      deps: {},
      aggregateId: v.observedAt.slice(0, 10),
      type: 'browser.timeline.observed',
      payload: {
        eventId: `tl-${String(i + 1).padStart(3, '0')}`,
        url: v.url,
        canonicalUrl: v.url,
        title: v.title,
        observedAt: v.observedAt,
        transition: 'activated',
        // Phase 4 — active-workstream attribution. Tagged visits
        // emit visit_in_workstream so ambient browsing attaches to
        // the focused flow without needing the URL pasted.
        ...(v.workstreamId === undefined ? {} : { workstreamId: v.workstreamId }),
      },
      acceptedAtMs: Date.parse(v.observedAt),
    })),
  });
};

// ---------------------------------------------------------------------------
// Fixture seed
// ---------------------------------------------------------------------------

interface SeedResult {
  readonly wsSecurityId: string;
  readonly wsPostgresId: string;
  readonly wsSidetrackId: string;
}

const seedAllFlows = async (comp: TestCompanion): Promise<SeedResult> => {
  // Workstreams — POST /v1/workstreams generates its own bac_id, so
  // we capture the returned id and use it as the foreign key for
  // threads / dispatches. Parent chain skipped here (the route's
  // parent resolution requires the parent JSON file to already
  // exist on disk and the test seeds in a single shot).
  const wsSecurityId = await seedWorkstream(comp, 'Security · Linux CVE');
  const wsPostgresId = await seedWorkstream(comp, 'Postgres · MERGE semantics');
  const wsSidetrackId = await seedWorkstream(comp, 'Sidetrack · project review');

  // Threads
  await seedThread(comp, {
    bac_id: T_CVE_CLAUDE,
    provider: 'claude',
    threadUrl: URL_CLAUDE_CVE,
    title: 'Claude — copy_file_range CVE',
    primaryWorkstreamId: wsSecurityId,
    lastSeenAt: '2026-05-07T09:18:00.000Z',
  });
  await seedThread(comp, {
    bac_id: T_CVE_CHATGPT,
    provider: 'chatgpt',
    threadUrl: URL_CHATGPT_CVE,
    title: 'ChatGPT — review CVE repro',
    primaryWorkstreamId: wsSecurityId,
    lastSeenAt: '2026-05-07T09:30:00.000Z',
  });
  await seedThread(comp, {
    bac_id: T_PG_CLAUDE,
    provider: 'claude',
    threadUrl: URL_CLAUDE_PG,
    title: 'Claude — MERGE vs UPSERT',
    primaryWorkstreamId: wsPostgresId,
    lastSeenAt: '2026-05-07T09:24:00.000Z',
  });
  await seedThread(comp, {
    bac_id: T_PG_CHATGPT,
    provider: 'chatgpt',
    threadUrl: URL_CHATGPT_PG,
    title: 'ChatGPT — review SQL plan',
    primaryWorkstreamId: wsPostgresId,
    lastSeenAt: '2026-05-07T09:28:00.000Z',
  });
  await seedThread(comp, {
    bac_id: T_SB_CLAUDE,
    provider: 'claude',
    threadUrl: URL_CLAUDE_SB,
    title: 'Claude — m2 dispatch design review',
    primaryWorkstreamId: wsSidetrackId,
    lastSeenAt: '2026-05-07T09:19:00.000Z',
  });
  await seedThread(comp, {
    bac_id: T_SB_CHATGPT,
    provider: 'chatgpt',
    threadUrl: URL_CHATGPT_SB,
    title: 'ChatGPT — review reducer code',
    primaryWorkstreamId: wsSidetrackId,
    lastSeenAt: '2026-05-07T09:31:00.000Z',
  });

  // Captures (each Claude thread cites URLs; assistant turns set
  // up thread_quotes_thread with the ChatGPT review threads).
  await seedCapture(comp, {
    threadId: T_CVE_CLAUDE,
    threadUrl: URL_CLAUDE_CVE,
    provider: 'claude',
    title: 'Claude — copy_file_range CVE',
    capturedAt: '2026-05-07T09:18:00.000Z',
    turns: [
      {
        role: 'user',
        text: `i'm reading ${URL_HN_COPYFAIL} plus the ${URL_XINT_BLOG} writeup. NVD says ${URL_NVD_CVE}. explain the socket angle.`,
      },
      {
        role: 'assistant',
        text: `here's a Python reproducer:\n${PYTHON_REPRO_BLOCK}\nthat exercises the bug.`,
      },
    ],
  });
  await seedCapture(comp, {
    threadId: T_CVE_CHATGPT,
    threadUrl: URL_CHATGPT_CVE,
    provider: 'chatgpt',
    title: 'ChatGPT — review CVE repro',
    capturedAt: '2026-05-07T09:30:00.000Z',
    turns: [
      { role: 'user', text: `please audit this:\n${PYTHON_REPRO_BLOCK}\nis it sound?` },
    ],
  });
  await seedCapture(comp, {
    threadId: T_PG_CLAUDE,
    threadUrl: URL_CLAUDE_PG,
    provider: 'claude',
    title: 'Claude — MERGE vs UPSERT',
    capturedAt: '2026-05-07T09:24:00.000Z',
    turns: [
      {
        role: 'user',
        text: `context: ${URL_HN_PGMERGE}, ${URL_PG_BLOG}, ${URL_PG_DOCS}. compare MERGE vs INSERT ON CONFLICT for our use case.`,
      },
      {
        role: 'assistant',
        text: `concrete example:\n${SQL_MERGE_BLOCK}\n— note the isolation pitfall.`,
      },
    ],
  });
  await seedCapture(comp, {
    threadId: T_PG_CHATGPT,
    threadUrl: URL_CHATGPT_PG,
    provider: 'chatgpt',
    title: 'ChatGPT — review SQL plan',
    capturedAt: '2026-05-07T09:28:00.000Z',
    turns: [
      {
        role: 'user',
        text: `review this query for concurrent safety:\n${SQL_MERGE_BLOCK}`,
      },
    ],
  });
  await seedCapture(comp, {
    threadId: T_SB_CLAUDE,
    threadUrl: URL_CLAUDE_SB,
    provider: 'claude',
    title: 'Claude — m2 dispatch design review',
    capturedAt: '2026-05-07T09:19:00.000Z',
    turns: [
      {
        role: 'user',
        text: `reviewing ${URL_GH_PR} and the design at ${URL_GH_BRAINSTORM}. also see the HN backref ${URL_HN_PGMERGE}.`,
      },
      {
        role: 'assistant',
        text: `proposed shape:\n${REDUCER_TS_BLOCK}\n  // pass 1, pass 2, pass 3 — same idempotency rules.`,
      },
    ],
  });
  await seedCapture(comp, {
    threadId: T_SB_CHATGPT,
    threadUrl: URL_CHATGPT_SB,
    provider: 'chatgpt',
    title: 'ChatGPT — review reducer code',
    capturedAt: '2026-05-07T09:31:00.000Z',
    turns: [
      {
        role: 'user',
        text: `please review this sketch:\n${REDUCER_TS_BLOCK}\n  // is the type correct?`,
      },
    ],
  });

  // Dispatches (sourceThreadId = the Claude thread; workstreamId =
  // the flow's workstream; mcpRequest is what produces
  // dispatch_requested_coding_session).
  await seedDispatch(comp, {
    bac_id: 'd_cve_codex',
    title: 'Codex — Python repro for CVE-2024-12345',
    target: { provider: 'codex' },
    workstreamId: wsSecurityId,
    sourceThreadId: T_CVE_CLAUDE,
    body: `please write a Python repro for ${URL_NVD_CVE}; checkpoint at boundary conditions.`,
    createdAt: '2026-05-07T09:22:00.000Z',
  });
  await seedDispatch(comp, {
    bac_id: 'd_pg_codex',
    title: 'Codex — refactor migration',
    target: { provider: 'codex' },
    workstreamId: wsPostgresId,
    sourceThreadId: T_PG_CLAUDE,
    body: `refactor migration; reference ${URL_PG_BLOG} for the failure mode.`,
    createdAt: '2026-05-07T09:32:00.000Z',
  });
  await seedDispatch(comp, {
    bac_id: 'd_sb_refactor',
    title: 'Claude Code — refactor reducer pass-2',
    target: { provider: 'claude_code' },
    workstreamId: wsSidetrackId,
    sourceThreadId: T_SB_CLAUDE,
    body: `refactor pass-2 per ${URL_GH_BRAINSTORM} §27.`,
    createdAt: '2026-05-07T09:24:00.000Z',
  });

  // Queue items
  await seedQueue(comp, {
    bac_id: 'q_cve_ws',
    text: 'test repro on Ubuntu 22 + 24',
    scope: 'workstream',
    targetId: wsSecurityId,
  });
  await seedQueue(comp, {
    bac_id: 'q_pg_t',
    text: 'document MERGE isolation pitfall',
    scope: 'thread',
    targetId: T_PG_CLAUDE,
  });

  // Annotations
  await seedAnnotation(comp, {
    bac_id: 'a_cve_kernel',
    url: URL_KERNEL_DOC,
    note: `the unsafe path is here. cross-ref ${URL_NVD_CVE}.`,
    pageTitle: 'man copy_file_range',
  });
  await seedAnnotation(comp, {
    bac_id: 'a_cve_thread',
    url: URL_CLAUDE_CVE,
    note: 'check assistant assumed AF_UNIX abstract namespace',
    pageTitle: 'Claude — CVE chat',
  });
  await seedAnnotation(comp, {
    bac_id: 'a_pg_doc',
    url: URL_PG_DOCS,
    note: `note: see ${URL_PG_BLOG} for the failure mode.`,
    pageTitle: 'PostgreSQL: MERGE',
  });
  await seedAnnotation(comp, {
    bac_id: 'a_sb_brainstorm',
    url: URL_GH_BRAINSTORM,
    note: 'needs §27 cross-ref to BRAINSTORM',
    pageTitle: 'BRAINSTORM.md',
  });

  // Timeline visits — last to ensure visit nodes exist when the
  // reducer's pass 4 looks them up. Phase 4: HN_COPYFAIL is tagged
  // with the active workstream so visit_in_workstream is exercised
  // through the live HTTP path. Ambient cross-flow URLs left
  // untagged so the per-anchor separation assertions still hold.
  await seedTimelineVisits(comp, [
    { url: URL_HN_COPYFAIL, observedAt: '2026-05-07T09:00:00.000Z', title: 'HN: copy-fail breaks distros', workstreamId: wsSecurityId },
    { url: URL_GH_PR, observedAt: '2026-05-07T09:05:00.000Z', title: 'sidetrack/sidetrack PR #98' },
    { url: URL_XINT_BLOG, observedAt: '2026-05-07T09:05:30.000Z', title: 'copy-fail across linux distros' },
    { url: URL_GOOGLE_CVE, observedAt: '2026-05-07T09:08:00.000Z', title: 'Google: linux copy_file_range CVE' },
    { url: URL_KERNEL_DOC, observedAt: '2026-05-07T09:10:00.000Z', title: 'man copy_file_range(2)' },
    { url: URL_GH_BRAINSTORM, observedAt: '2026-05-07T09:11:00.000Z', title: 'BRAINSTORM.md' },
    { url: URL_HN_PGMERGE, observedAt: '2026-05-07T09:12:00.000Z', title: 'HN: postgres MERGE pitfalls' },
    { url: URL_NVD_CVE, observedAt: '2026-05-07T09:14:00.000Z', title: 'NVD CVE-2024-12345' },
    { url: URL_PG_BLOG, observedAt: '2026-05-07T09:15:00.000Z', title: 'MERGE pitfalls (blog)' },
    { url: URL_HN_PGMERGE, observedAt: '2026-05-07T09:16:00.000Z', title: 'HN: postgres MERGE pitfalls' },
    { url: URL_CLAUDE_CVE, observedAt: '2026-05-07T09:18:00.000Z', title: 'Claude — CVE chat' },
    { url: URL_CLAUDE_SB, observedAt: '2026-05-07T09:18:30.000Z', title: 'Claude — sb chat' },
    { url: URL_PG_DOCS, observedAt: '2026-05-07T09:20:00.000Z', title: 'PostgreSQL: MERGE' },
    { url: URL_CLAUDE_PG, observedAt: '2026-05-07T09:23:00.000Z', title: 'Claude — pg chat' },
    { url: URL_CHATGPT_PG, observedAt: '2026-05-07T09:27:00.000Z', title: 'ChatGPT — pg review' },
    { url: URL_CHATGPT_CVE, observedAt: '2026-05-07T09:29:00.000Z', title: 'ChatGPT — cve review' },
    { url: URL_CHATGPT_SB, observedAt: '2026-05-07T09:30:30.000Z', title: 'ChatGPT — sb review' },
  ]);
  return { wsSecurityId, wsPostgresId, wsSidetrackId };
};

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

interface ConnectionsEnvelope {
  data: {
    scope: string;
    snapshot: {
      nodes: Array<{ id: string; kind: string }>;
      edges: Array<{ id: string; kind: string; fromNodeId: string; toNodeId: string }>;
      edgeCount: number;
      nodeCount: number;
    };
  };
}

const fetchNeighbors = async (
  comp: TestCompanion,
  anchorId: string,
  hops = 2,
): Promise<ConnectionsEnvelope['data']> => {
  const encoded = encodeURIComponent(anchorId);
  const result = (await apiGet(
    comp,
    `/v1/connections/nodes/${encoded}/neighbors?hops=${String(hops)}`,
  )) as ConnectionsEnvelope;
  return result.data;
};

// The connections materializer is event-driven and async — it queues
// a drain on every onAccepted call and runs in the background. After
// our seed POSTs return we have to wait for the drain to complete
// before reading the snapshot. Poll every 100ms until edgeCount has
// been stable for `stableMs` consecutive milliseconds AND at least
// one drain has produced edges, then return.
//
// `stableMs` (2500 ms default) is intentionally above the
// materializer's DRAIN_DEBOUNCE_MS (1500 ms). Without that headroom
// the helper can return after 600 ms of "stable" zero-edge polling
// before the first drain fires — the snapshot looks empty and every
// assertion downstream reads zero edges. `requireNonZero` (default
// true) defends against the same race for callers that seed real
// data; pass `false` for "this test seeds nothing on purpose".
const waitForSnapshotToStabilize = async (
  comp: TestCompanion,
  options: { stableMs?: number; timeoutMs?: number; requireNonZero?: boolean } = {},
): Promise<void> => {
  const stableMs = options.stableMs ?? 2_500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const requireNonZero = options.requireNonZero ?? true;
  const startedMs = Date.now();
  let lastCount = -1;
  let stableSinceMs = 0;
  while (Date.now() - startedMs < timeoutMs) {
    const all = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    const count = all.data.snapshot.edgeCount;
    if (count === lastCount) {
      const stable = Date.now() - stableSinceMs >= stableMs;
      if (stable && (!requireNonZero || count > 0)) return;
    } else {
      lastCount = count;
      stableSinceMs = Date.now();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `connections snapshot did not stabilize within ${String(timeoutMs)}ms (last edgeCount=${String(lastCount)})`,
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('connections — multi-flow HTTP integration', () => {
  let companion: TestCompanion | null = null;
  let seed: SeedResult | null = null;

  test.beforeAll(async () => {
    companion = await startTestCompanion();
    seed = await seedAllFlows(companion);
    await waitForSnapshotToStabilize(companion);
  });

  test.afterAll(async () => {
    if (companion !== null) await companion.close();
    companion = null;
    seed = null;
  });

  test('Flow A (ws_security) anchor surfaces only Flow A nodes', async () => {
    if (companion === null || seed === null) throw new Error('companion not started');
    const data = await fetchNeighbors(companion, `workstream:${seed.wsSecurityId}`, 2);
    const ids = new Set(data.snapshot.nodes.map((n) => n.id));
    expect(ids.has(`workstream:${seed.wsSecurityId}`)).toBe(true);
    expect(ids.has(`thread:${T_CVE_CLAUDE}`)).toBe(true);
    expect(ids.has(`thread:${T_CVE_CHATGPT}`)).toBe(true);
    expect(ids.has('dispatch:d_cve_codex')).toBe(true);
    // No leakage from B or C threads.
    expect(ids.has(`thread:${T_PG_CLAUDE}`)).toBe(false);
    expect(ids.has(`thread:${T_SB_CLAUDE}`)).toBe(false);
    expect(ids.has(`workstream:${seed.wsPostgresId}`)).toBe(false);
    expect(ids.has(`workstream:${seed.wsSidetrackId}`)).toBe(false);
  });

  test('Flow B (ws_postgres) anchor surfaces only Flow B nodes', async () => {
    if (companion === null || seed === null) throw new Error('companion not started');
    const data = await fetchNeighbors(companion, `workstream:${seed.wsPostgresId}`, 2);
    const ids = new Set(data.snapshot.nodes.map((n) => n.id));
    expect(ids.has(`thread:${T_PG_CLAUDE}`)).toBe(true);
    expect(ids.has(`thread:${T_PG_CHATGPT}`)).toBe(true);
    expect(ids.has('dispatch:d_pg_codex')).toBe(true);
    expect(ids.has(`thread:${T_CVE_CLAUDE}`)).toBe(false);
    expect(ids.has(`thread:${T_SB_CLAUDE}`)).toBe(false);
  });

  test('Flow C (ws_sidetrack) anchor surfaces only Flow C nodes', async () => {
    if (companion === null || seed === null) throw new Error('companion not started');
    const data = await fetchNeighbors(companion, `workstream:${seed.wsSidetrackId}`, 2);
    const ids = new Set(data.snapshot.nodes.map((n) => n.id));
    expect(ids.has(`thread:${T_SB_CLAUDE}`)).toBe(true);
    expect(ids.has(`thread:${T_SB_CHATGPT}`)).toBe(true);
    expect(ids.has('dispatch:d_sb_refactor')).toBe(true);
    expect(ids.has(`thread:${T_CVE_CLAUDE}`)).toBe(false);
    expect(ids.has(`thread:${T_PG_CLAUDE}`)).toBe(false);
  });

  test('cross-flow HN URL anchor reveals both Postgres and Sidetrack Claude threads', async () => {
    if (companion === null) throw new Error('companion not started');
    const visitId = `timeline-visit:${URL_HN_PGMERGE}`;
    const data = await fetchNeighbors(companion, visitId, 1);
    const ids = new Set(data.snapshot.nodes.map((n) => n.id));
    expect(ids.has(`thread:${T_PG_CLAUDE}`)).toBe(true);
    expect(ids.has(`thread:${T_SB_CLAUDE}`)).toBe(true);
  });

  test('emits content-derived edges from real captures + dispatches + annotations', async () => {
    if (companion === null) throw new Error('companion not started');
    const all = (await apiGet(companion, '/v1/connections')) as ConnectionsEnvelope;
    const kinds = new Set(all.data.snapshot.edges.map((e) => e.kind));
    // Edges this Layer-3 setup CAN produce (vault + event paths
    // available via public HTTP). The Layer-1 reducer test covers
    // the full 16-edge set; this layer asserts the HTTP path
    // produces the content-derived ones we care about for
    // separation testing.
    const expected = [
      'thread_in_workstream',
      'dispatch_from_thread',
      'dispatch_in_workstream',
      'queue_targets_thread',
      'queue_targets_workstream',
      'timeline_same_url_as_thread',
      'annotation_targets_thread',
      'thread_references_url',
      'dispatch_references_url',
      'annotation_references_url',
      'thread_quotes_thread',
      'visit_in_workstream',
    ];
    const missing = expected.filter((k) => !kinds.has(k));
    expect(missing).toEqual([]);
  });

  test('visit_in_workstream: a tagged ambient visit attaches to its workstream subgraph', async () => {
    if (companion === null || seed === null) throw new Error('companion not started');
    const wsId = seed.wsSecurityId;
    // The HN_COPYFAIL visit was seeded with workstreamId=wsSecurityId
    // — anchored on ws_security at hops=2, the visit must appear in
    // the subgraph (it's reachable directly via visit_in_workstream).
    const data = await fetchNeighbors(companion, `workstream:${wsId}`, 2);
    const ids = new Set(data.snapshot.nodes.map((n) => n.id));
    expect(ids.has(`timeline-visit:${URL_HN_COPYFAIL}`)).toBe(true);
    const edge = data.snapshot.edges.find(
      (e) =>
        e.kind === 'visit_in_workstream' &&
        e.fromNodeId === `timeline-visit:${URL_HN_COPYFAIL}` &&
        e.toNodeId === `workstream:${wsId}`,
    );
    expect(edge, 'visit_in_workstream edge expected through HTTP layer').toBeDefined();
  });
});
