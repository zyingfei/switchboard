// PoC: Gemini Nano (Chrome built-in Prompt API) title synthesis for
// junk-titled entities — the measured accuracy defect this attacks: chat
// turns titled "ChatGPT"/"Branch · X" and URL-as-title visits carry
// title-only vectors + junk terms, polluting the title lane, FTS, and the
// content lane's neighbor tails (PGSimCity probe, 2026-07-27).
//
// Run: PATH="$HOME/.bun/bin:$PATH" bun poc/nano-title-synthesis/harness.ts
// Requires: test browser on CDP :9222 with the sidepanel open (extension
// context exposes LanguageModel), test companion on :17374.
//
// The harness:
//   1. Feature-detects LanguageModel in the panel context; waits (bounded)
//      for availability 'available' (drives the download via create()).
//   2. Selects junk-titled chat threads from the companion — SELECTION IS
//      STRUCTURAL, not vocabulary: a title is junk-selected when it is
//      URL-shaped, OR it recurs verbatim across ≥3 distinct threads
//      (measured sameness — provider default titles recur; real titles
//      don't), OR it is empty.
//   3. Pulls each thread's markdown, prompts Nano to title it FROM THE
//      CONTENT ONLY (explicit abstain instruction — no hallucinated
//      titles), measures latency.
//   4. Prints before/after + latency for human quality judgment. No
//      writes anywhere — pure read + generate.

const CDP_LIST = 'http://127.0.0.1:9222/json/list';
const COMPANION = 'http://127.0.0.1:17374';
const MAX_ITEMS = 8;
const MARKDOWN_CHARS = 2200;
const AVAILABILITY_WAIT_MS = 12 * 60 * 1000;

const bridgeKey = await Bun.file(
  `${process.env['HOME']}/.sidetrack-vault-test/_BAC/.config/bridge.key`,
).text();

const companionJson = async (path: string): Promise<unknown> => {
  const res = await fetch(`${COMPANION}${path}`, {
    headers: { 'x-bac-bridge-key': bridgeKey.trim() },
  });
  if (!res.ok) throw new Error(`${path} -> ${String(res.status)}`);
  return res.json();
};

const companionText = async (path: string): Promise<string> => {
  const res = await fetch(`${COMPANION}${path}`, {
    headers: { 'x-bac-bridge-key': bridgeKey.trim() },
  });
  if (!res.ok) return '';
  const body = (await res.json().catch(() => null)) as { data?: { markdown?: string } } | null;
  if (body?.data?.markdown !== undefined) return body.data.markdown;
  return '';
};

// ---- CDP eval in the extension panel context ---------------------------

const panelTarget = async (): Promise<string> => {
  const res = await fetch(CDP_LIST);
  const targets = (await res.json()) as { url?: string; webSocketDebuggerUrl?: string }[];
  const panel = targets.find((t) => (t.url ?? '').includes('sidepanel.html'));
  if (panel?.webSocketDebuggerUrl === undefined) {
    throw new Error('no sidepanel target on :9222 — open the side panel first');
  }
  return panel.webSocketDebuggerUrl;
};

let evalCounter = 0;
const cdpEval = async (wsUrl: string, expression: string, timeoutMs: number): Promise<unknown> => {
  const ws = new WebSocket(wsUrl);
  evalCounter += 1;
  const id = evalCounter;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* closed */ }
      reject(new Error('cdp eval timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as {
        id?: number;
        result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
      };
      if (m.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* closed */ }
      if (m.result?.exceptionDetails !== undefined) {
        reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
        return;
      }
      resolve(m.result?.result?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
};

// ---- 1. availability ---------------------------------------------------

const ws = await panelTarget();
const availability = async (): Promise<string> =>
  String(await cdpEval(ws, `(async () => {
    if (typeof LanguageModel === 'undefined') return 'no-api';
    try { return await LanguageModel.availability(); } catch (e) { return 'error:' + String(e); }
  })()`, 15_000));

let state = await availability();
console.log(`[nano-poc] availability: ${state}`);
if (state === 'downloadable' || state === 'downloading') {
  // Drive the download; poll until available or deadline.
  await cdpEval(ws, `(async () => {
    globalThis.__nanoDrive ??= LanguageModel.create().then(() => 'ok').catch((e) => 'err:' + String(e));
    return 'driving';
  })()`, 15_000);
  const deadline = Date.now() + AVAILABILITY_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));
    state = await availability();
    console.log(`[nano-poc] availability: ${state}`);
    if (state === 'available' || state.startsWith('error') || state === 'unavailable') break;
  }
}
if (state !== 'available') {
  console.log(`[nano-poc] RESULT: model not usable on this machine/browser (terminal state: ${state}).`);
  process.exit(2);
}

// ---- 2. structural junk-title selection --------------------------------

interface ThreadRow { readonly bac_id: string; readonly title?: string }
const threadsBody = (await companionJson('/v1/threads')) as { data?: ThreadRow[] };
const threads = threadsBody.data ?? [];
const titleCounts = new Map<string, number>();
for (const t of threads) {
  const title = (t.title ?? '').trim();
  titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
}
const isJunk = (title: string): boolean =>
  title.length === 0 ||
  /^https?:\/\//iu.test(title) ||
  (titleCounts.get(title) ?? 0) >= 3;
const junkThreads = threads.filter((t) => isJunk((t.title ?? '').trim())).slice(0, MAX_ITEMS);
console.log(`[nano-poc] threads: ${String(threads.length)} total, ${String(junkThreads.length)} junk-titled selected`);
if (junkThreads.length === 0) {
  console.log('[nano-poc] RESULT: no junk-titled threads found — nothing to evaluate.');
  process.exit(0);
}

// ---- 3. synthesis ------------------------------------------------------

const PROMPT_PREFIX = [
  'You title documents for a personal research organizer.',
  'Write ONE descriptive title, 4 to 10 words, for the conversation below.',
  'Use ONLY facts present in the text. Name the specific technology,',
  'product, or question discussed. No quotes, no trailing punctuation.',
  'If the text is too thin to title faithfully, reply exactly: SKIP',
  '',
  'Conversation:',
].join('\n');

interface Result { readonly id: string; readonly before: string; readonly after: string; readonly ms: number }
const results: Result[] = [];
for (const t of junkThreads) {
  const md = (await companionText(`/v1/threads/${encodeURIComponent(t.bac_id)}/markdown`))
    .slice(0, MARKDOWN_CHARS);
  if (md.trim().length < 80) {
    results.push({ id: t.bac_id, before: t.title ?? '', after: '(content too thin — skipped)', ms: 0 });
    continue;
  }
  const started = Date.now();
  const out = await cdpEval(ws, `(async () => {
    const session = await LanguageModel.create();
    try {
      const reply = await session.prompt(${JSON.stringify(`${PROMPT_PREFIX}\n${'-'.repeat(3)}\n`)} + ${JSON.stringify(md)});
      return String(reply).trim();
    } finally { session.destroy(); }
  })()`, 60_000).catch((e: unknown) => `(error: ${String(e)})`);
  results.push({ id: t.bac_id, before: t.title ?? '', after: String(out), ms: Date.now() - started });
}

// ---- 4. report ---------------------------------------------------------

console.log('\n[nano-poc] BEFORE -> AFTER (latency)');
for (const r of results) {
  console.log(`  [${String(r.ms)}ms] "${r.before}" -> "${r.after}"  (${r.id.slice(0, 12)})`);
}
const generated = results.filter((r) => r.ms > 0 && !r.after.startsWith('(') && r.after !== 'SKIP');
console.log(`\n[nano-poc] generated ${String(generated.length)}/${String(results.length)}; ` +
  `median latency ${String([...generated].sort((a, b) => a.ms - b.ms)[Math.floor(generated.length / 2)]?.ms ?? 0)}ms`);
