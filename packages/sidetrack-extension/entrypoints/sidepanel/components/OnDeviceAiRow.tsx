import { useCallback, useEffect, useRef, useState } from 'react';

// On-device AI (Gemini Nano / Chrome built-in Prompt API) availability row
// for the Health panel's Experiments drill.
//
// This is a BROWSER capability, not a companion candidate lane — the panel
// probes its own extension context (the Prompt API is exposed to extension
// pages on Chrome 138+) and reports what it finds. PoC evidence
// (poc/nano-title-synthesis/README.md): the API surface exists in the test
// browser but Chrome for Testing cannot deliver the model component; regular
// Chrome can. This row makes the per-browser truth visible so the title-
// synthesis quality gate can run where the model actually lands.
//
// The multi-GB model download starts ONLY from the explicit button —
// availability() is a passive read; create() is the download trigger and is
// never called without user intent.

// Minimal ambient shape for the built-in Prompt API — not yet in TS's DOM
// lib. Feature-detected at runtime; every call is guarded.
interface BuiltinLanguageModel {
  availability: () => Promise<string>;
  create: (options?: {
    monitor?: (m: {
      addEventListener: (type: 'downloadprogress', cb: (e: { loaded: number }) => void) => void;
    }) => void;
    expectedInputs?: readonly { type: 'text'; languages: readonly string[] }[];
    expectedOutputs?: readonly { type: 'text'; languages: readonly string[] }[];
  }) => Promise<{ destroy: () => void; prompt: (text: string) => Promise<string> }>;
}

// The vault is bilingual (English + Chinese threads); declaring both as
// expected input AND output languages lets Chrome fetch any language pack it
// needs and keeps output quality honest for zh content. Older Chromes that
// reject the language options fall back to a plain create().
const EVAL_LANGUAGES: readonly string[] = ['en', 'zh'];
const createEvalSession = async (
  lm: BuiltinLanguageModel,
): Promise<{ destroy: () => void; prompt: (text: string) => Promise<string> }> => {
  try {
    return await lm.create({
      expectedInputs: [{ type: 'text', languages: EVAL_LANGUAGES }],
      expectedOutputs: [{ type: 'text', languages: EVAL_LANGUAGES }],
    });
  } catch {
    return await lm.create();
  }
};

const builtinLanguageModel = (): BuiltinLanguageModel | undefined => {
  const candidate = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  if (candidate === undefined || candidate === null) return undefined;
  return candidate as BuiltinLanguageModel;
};

export type OnDeviceAiState =
  | 'no-api'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available'
  | 'error';

const STATE_COPY: Record<OnDeviceAiState, string> = {
  'no-api': 'not exposed by this browser',
  unavailable: 'this device/browser cannot run the model',
  downloadable: 'model not downloaded yet',
  downloading: 'model downloading…',
  available: 'ready',
  error: 'probe failed',
};

// ---- title-synthesis eval (the PoC quality gate, run where the model
// actually exists — poc/nano-title-synthesis/README.md) -------------------
//
// Observe-only: reads junk-titled threads from the companion, titles them
// with Nano ON-DEVICE, and renders before→after + latency for human
// judgment. No writes anywhere; nothing feeds serving. Junk selection is
// STRUCTURAL (empty / URL-shaped / verbatim-recurring across ≥3 threads) —
// no vocabulary lists.

const EVAL_MAX_ITEMS = 8;
const EVAL_MARKDOWN_CHARS = 2200;
const EVAL_PROMPT_PREFIX = [
  'You title documents for a personal research organizer.',
  'Write ONE descriptive title, 4 to 10 words, for the conversation below.',
  'Write the title in the SAME language the conversation is mostly written',
  'in (English conversation → English title, 中文对话 → 中文标题).',
  'Use ONLY facts present in the text. Name the specific technology,',
  'product, or question discussed. No quotes, no trailing punctuation.',
  'If the text is too thin to title faithfully, reply exactly: SKIP',
  '',
  'Conversation:',
  '---',
].join('\n');

export interface TitleEvalResult {
  readonly threadId: string;
  readonly before: string;
  readonly after: string;
  readonly ms: number;
}

export interface OnDeviceAiRowProps {
  readonly companionPort?: number | null;
  readonly bridgeKey?: string | null;
}

export function OnDeviceAiRow({ companionPort, bridgeKey }: OnDeviceAiRowProps = {}) {
  const [state, setState] = useState<OnDeviceAiState>('no-api');
  const [progress, setProgress] = useState<number | null>(null);
  const [kicked, setKicked] = useState(false);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalResults, setEvalResults] = useState<readonly TitleEvalResult[] | null>(null);
  const [evalNote, setEvalNote] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const probe = useCallback(async (): Promise<void> => {
    const lm = builtinLanguageModel();
    if (lm === undefined) {
      setState('no-api');
      return;
    }
    try {
      const availability = await lm.availability();
      if (!mountedRef.current) return;
      setState(
        availability === 'available' ||
          availability === 'downloadable' ||
          availability === 'downloading' ||
          availability === 'unavailable'
          ? availability
          : 'error',
      );
    } catch {
      if (mountedRef.current) setState('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void probe();
    return () => {
      mountedRef.current = false;
    };
  }, [probe]);

  // While a download is in flight, refresh the availability read on a slow
  // cadence so the row converges to 'available' without a manual reopen.
  useEffect(() => {
    if (state !== 'downloading') return undefined;
    const timer = window.setInterval(() => {
      void probe();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [state, probe]);

  const startDownload = useCallback((): void => {
    const lm = builtinLanguageModel();
    if (lm === undefined) return;
    setKicked(true);
    void lm
      .create({
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e) => {
            if (mountedRef.current) setProgress(e.loaded);
          });
        },
      })
      .then((session) => {
        session.destroy();
        if (mountedRef.current) setState('available');
      })
      .catch(() => {
        if (mountedRef.current) void probe();
      });
    setState('downloading');
  }, [probe]);

  const runTitleEval = useCallback(async (): Promise<void> => {
    const lm = builtinLanguageModel();
    if (
      lm === undefined ||
      companionPort === null ||
      companionPort === undefined ||
      bridgeKey === null ||
      bridgeKey === undefined
    ) {
      return;
    }
    setEvalRunning(true);
    setEvalResults(null);
    setEvalNote(null);
    try {
      const headers = { 'x-bac-bridge-key': bridgeKey };
      const listRes = await fetch(`http://127.0.0.1:${String(companionPort)}/v1/threads`, {
        headers,
      });
      if (!listRes.ok) {
        setEvalNote(`thread list failed (${String(listRes.status)})`);
        return;
      }
      const listBody = (await listRes.json()) as {
        readonly data?: readonly { readonly bac_id: string; readonly title?: string }[];
      };
      const threads = listBody.data ?? [];
      // Structural junk selection: empty, URL-shaped, or a title recurring
      // verbatim across ≥3 distinct threads (provider defaults recur; real
      // titles don't).
      const titleCounts = new Map<string, number>();
      for (const t of threads) {
        const title = (t.title ?? '').trim();
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      }
      const junk = threads
        .filter((t) => {
          const title = (t.title ?? '').trim();
          return (
            title.length === 0 ||
            /^https?:\/\//iu.test(title) ||
            (titleCounts.get(title) ?? 0) >= 3
          );
        })
        .slice(0, EVAL_MAX_ITEMS);
      if (junk.length === 0) {
        setEvalNote('no junk-titled threads found — nothing to evaluate');
        return;
      }
      const results: TitleEvalResult[] = [];
      for (const t of junk) {
        const mdRes = await fetch(
          `http://127.0.0.1:${String(companionPort)}/v1/threads/${encodeURIComponent(t.bac_id)}/markdown`,
          { headers },
        );
        const mdBody = mdRes.ok
          ? ((await mdRes.json().catch(() => null)) as { data?: { markdown?: string } } | null)
          : null;
        const markdown = (mdBody?.data?.markdown ?? '').slice(0, EVAL_MARKDOWN_CHARS);
        if (markdown.trim().length < 80) {
          results.push({
            threadId: t.bac_id,
            before: t.title ?? '',
            after: '(content too thin — skipped)',
            ms: 0,
          });
          continue;
        }
        const started = Date.now();
        let after: string;
        try {
          const session = await createEvalSession(lm);
          try {
            after = (await session.prompt(`${EVAL_PROMPT_PREFIX}\n${markdown}`)).trim();
          } finally {
            session.destroy();
          }
        } catch (err) {
          after = `(error: ${String(err)})`;
        }
        results.push({ threadId: t.bac_id, before: t.title ?? '', after, ms: Date.now() - started });
        if (!mountedRef.current) return;
        setEvalResults([...results]);
      }
      setEvalResults(results);
    } finally {
      if (mountedRef.current) setEvalRunning(false);
    }
  }, [companionPort, bridgeKey]);

  const evalAvailable =
    state === 'available' &&
    companionPort !== null &&
    companionPort !== undefined &&
    bridgeKey !== null &&
    bridgeKey !== undefined;

  return (
    <div className="sx-callout" data-testid="hp-ondevice-ai">
      <strong>On-device AI (Gemini Nano)</strong>
      {' · '}
      <span data-testid="hp-ondevice-ai-state">{STATE_COPY[state]}</span>
      {state === 'downloading' && progress !== null ? (
        <span className="mono"> {String(Math.round(progress * 100))}%</span>
      ) : null}
      {state === 'downloadable' && !kicked ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          onClick={startDownload}
        >
          Download model
        </button>
      ) : null}
      {evalAvailable ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          disabled={evalRunning}
          onClick={() => {
            void runTitleEval();
          }}
          data-testid="hp-ondevice-ai-eval"
        >
          {evalRunning ? 'Evaluating…' : 'Run title-synthesis eval'}
        </button>
      ) : null}
      {evalNote !== null ? <div className="mono">{evalNote}</div> : null}
      {evalResults !== null ? (
        <div data-testid="hp-ondevice-ai-eval-results" style={{ marginTop: 6 }}>
          {evalResults.map((r) => (
            <div key={r.threadId} className="mono" style={{ marginTop: 4 }}>
              [{String(r.ms)}ms] “{r.before.length === 0 ? '(untitled)' : r.before}” → “{r.after}”
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
