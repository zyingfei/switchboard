// Realistic two-flow user-story fixture using URLs the user actually
// narrated:
//
//   Flow A — copy-fail Linux CVE
//     HN https://news.ycombinator.com/item?id=47952181
//     → blog https://xint.io/blog/copy-fail-linux-distributions
//     → google https://www.google.com/search?q=Linux+crypto+subsystem
//     → ChatGPT https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd
//     → copy.fail home
//     → github PoC https://github.com/theori-io/copy-fail-CVE-2026-31431/...
//     → dispatch to coding agent (cs_cve_vm) which starts its own thread
//
//   Flow B — switchboard project review (concurrent)
//     github https://github.com/zyingfei/switchboard
//     → PRs https://github.com/zyingfei/switchboard/pulls
//     → ChatGPT https://chatgpt.com/g/g-p-.../c/69fd259a...
//     → ChatGPT https://chatgpt.com/g/g-p-.../c/69fcb926...
//     → YouTube https://www.youtube.com/watch?v=rY44ViY45q8 (concurrent
//       background tab)
//     → Gemini https://gemini.google.com/app/7a97310e824ccad4 (analysis)
//
// The fixture takes a charitable view of what the user pastes into
// chats — natural references like "I'm reading <HN URL>" but NOT
// every visit. The Google search URL and YouTube URL are NOT pasted
// — they're ambient browsing.

import { ANNOTATION_CREATED } from '../../annotations/events.js';
import { DISPATCH_RECORDED } from '../../dispatches/events.js';
import { CAPTURE_RECORDED } from '../../recall/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import type { TimelineDayProjection } from '../../timeline/projection.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { nodeIdFor } from '../types.js';
import type {
  CodingSessionVaultRecord,
  ConnectionsInput,
  DispatchVaultRecord,
  ThreadVaultRecord,
  WorkstreamVaultRecord,
} from '../snapshot.js';

// ---------------------------------------------------------------------------
// URLs (narrated by the user)
// ---------------------------------------------------------------------------

// Flow A
export const URL_A_HN = 'https://news.ycombinator.com/item?id=47952181';
export const URL_A_BLOG = 'https://xint.io/blog/copy-fail-linux-distributions';
export const URL_A_GOOGLE_SEARCH =
  'https://www.google.com/search?q=Linux+crypto+subsystem&newwindow=1&sca_esv=9700858d11d87a5f&sxsrf=ANbL-n7otDb8AtUZOxbzZ4JQi1ezOpsbrw';
export const URL_A_CHATGPT = 'https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd';
export const URL_A_COPY_FAIL = 'https://copy.fail/';
export const URL_A_GITHUB_POC =
  'https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py';
// Coding-agent's thread URL — represents the dispatched session's chat.
export const URL_A_CODING_THREAD = 'https://claude.ai/chat/coding_agent_cve_repro';

// Flow B
export const URL_B_GH_REPO = 'https://github.com/zyingfei/switchboard';
export const URL_B_GH_PRS = 'https://github.com/zyingfei/switchboard/pulls';
export const URL_B_CHATGPT_1 =
  'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae-switchboard/c/69fd259a-83b0-8326-a4d9-c4c1b76a5986';
export const URL_B_CHATGPT_2 =
  'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69fcb926-3a98-8328-bbe4-baee4da7fbef';
export const URL_B_YOUTUBE = 'https://www.youtube.com/watch?v=rY44ViY45q8';
export const URL_B_GEMINI = 'https://gemini.google.com/app/7a97310e824ccad4?hl=en-US';

// ---------------------------------------------------------------------------
// Aggregate ids
// ---------------------------------------------------------------------------

export const WS_A_CVE = 'ws_realistic_cve';
export const WS_B_SWITCHBOARD = 'ws_realistic_switchboard';

export const T_A_CHATGPT = 't_realistic_a_chatgpt';
export const T_A_CODING = 't_realistic_a_coding';
export const T_B_CHATGPT_1 = 't_realistic_b_chatgpt_1';
export const T_B_CHATGPT_2 = 't_realistic_b_chatgpt_2';
export const T_B_GEMINI = 't_realistic_b_gemini';

export const D_A_DISPATCH_TO_CODING = 'd_realistic_a_codex';
export const CS_A_CODING = 'cs_realistic_a_vm';

export const A_A_GITHUB = 'a_realistic_a_github';

// Code substring that the coding-agent's thread quotes from the
// ChatGPT thread (mimics "ChatGPT explained the bug → coding agent
// pasted the same code into its planning").
const POC_CODE_SNIPPET =
  'ssize_t copy_file_range(int fd_in, off_t *off_in, int fd_out, off_t *off_out, size_t len, unsigned int flags)';

const REPLICA = 'replica-realistic';

// ---------------------------------------------------------------------------
// Vault records
// ---------------------------------------------------------------------------

const workstreams: readonly WorkstreamVaultRecord[] = [
  { bac_id: WS_A_CVE, title: 'Security · copy-fail CVE-2026-31431' },
  { bac_id: WS_B_SWITCHBOARD, title: 'Switchboard · project review' },
];

const threads: readonly ThreadVaultRecord[] = [
  {
    bac_id: T_A_CHATGPT,
    title: 'ChatGPT — copy_file_range CVE',
    threadUrl: URL_A_CHATGPT,
    canonicalUrl: URL_A_CHATGPT,
    provider: 'chatgpt',
    primaryWorkstreamId: WS_A_CVE,
    lastSeenAt: '2026-05-07T10:15:00.000Z',
  },
  {
    bac_id: T_A_CODING,
    title: 'Claude — copy-fail PoC repro plan',
    threadUrl: URL_A_CODING_THREAD,
    canonicalUrl: URL_A_CODING_THREAD,
    provider: 'claude',
    primaryWorkstreamId: WS_A_CVE,
    lastSeenAt: '2026-05-07T10:50:00.000Z',
  },
  {
    bac_id: T_B_CHATGPT_1,
    title: 'ChatGPT — Switchboard sync architecture',
    threadUrl: URL_B_CHATGPT_1,
    canonicalUrl: URL_B_CHATGPT_1,
    provider: 'chatgpt',
    primaryWorkstreamId: WS_B_SWITCHBOARD,
    lastSeenAt: '2026-05-07T10:25:00.000Z',
  },
  {
    bac_id: T_B_CHATGPT_2,
    title: 'ChatGPT — review Switchboard PRs',
    threadUrl: URL_B_CHATGPT_2,
    canonicalUrl: URL_B_CHATGPT_2,
    provider: 'chatgpt',
    primaryWorkstreamId: WS_B_SWITCHBOARD,
    lastSeenAt: '2026-05-07T10:40:00.000Z',
  },
  {
    bac_id: T_B_GEMINI,
    title: 'Gemini — Switchboard high-level analysis',
    threadUrl: URL_B_GEMINI,
    canonicalUrl: URL_B_GEMINI,
    provider: 'gemini',
    primaryWorkstreamId: WS_B_SWITCHBOARD,
    lastSeenAt: '2026-05-07T10:55:00.000Z',
  },
];

const dispatches: readonly DispatchVaultRecord[] = [
  {
    bac_id: D_A_DISPATCH_TO_CODING,
    title: 'Codex — try copy_fail_exp.py in a VM',
    target: { provider: 'codex' },
    status: 'sent',
    createdAt: '2026-05-07T10:35:00.000Z',
    sourceThreadId: T_A_CHATGPT,
    workstreamId: WS_A_CVE,
    mcpRequest: { codingSessionId: CS_A_CODING },
  },
];

const codingSessions: readonly CodingSessionVaultRecord[] = [
  {
    bac_id: CS_A_CODING,
    workstreamId: WS_A_CVE,
    tool: 'codex',
    cwd: '/work/cve-vm',
    name: 'cve-vm-repro',
    attachedAt: '2026-05-07T10:38:00.000Z',
    lastSeenAt: '2026-05-07T10:55:00.000Z',
    status: 'attached',
  },
];

// ---------------------------------------------------------------------------
// Timeline visits — every URL the user actually browsed.
// Includes ambient ones (Google search, YouTube, copy.fail home, HN)
// that the user did NOT necessarily paste into a chat.
// ---------------------------------------------------------------------------

// Phase 4 — visits carry workstreamId when the side-panel observer
// has a workstream focused at observation time. The user is in
// Flow A's workstream (ws_realistic_cve) for the CVE-related visits
// and Flow B's workstream (ws_realistic_switchboard) for the
// Switchboard-related ones. The truly ambient ones — copy.fail
// homepage browsed mid-CVE-research, YouTube as a background tab
// during Switchboard project review — pick up the workstream of
// the user's then-active flow even though they're never pasted
// into a chat. That's what closes the ambient-browsing gap.
const visits: ReadonlyArray<{ url: string; time: string; title: string; workstreamId?: string }> = [
  { url: URL_A_HN, time: '2026-05-07T10:00:00.000Z', title: 'HN: copy-fail Linux CVE', workstreamId: WS_A_CVE },
  { url: URL_B_GH_REPO, time: '2026-05-07T10:02:00.000Z', title: 'switchboard GitHub', workstreamId: WS_B_SWITCHBOARD },
  { url: URL_A_BLOG, time: '2026-05-07T10:05:00.000Z', title: 'copy-fail across linux distros', workstreamId: WS_A_CVE },
  { url: URL_B_GH_PRS, time: '2026-05-07T10:07:00.000Z', title: 'switchboard PRs', workstreamId: WS_B_SWITCHBOARD },
  { url: URL_A_GOOGLE_SEARCH, time: '2026-05-07T10:08:00.000Z', title: 'Google: Linux crypto subsystem', workstreamId: WS_A_CVE },
  { url: URL_A_CHATGPT, time: '2026-05-07T10:10:00.000Z', title: 'ChatGPT — CVE chat', workstreamId: WS_A_CVE },
  { url: URL_B_CHATGPT_1, time: '2026-05-07T10:20:00.000Z', title: 'ChatGPT — Switchboard sync', workstreamId: WS_B_SWITCHBOARD },
  { url: URL_A_BLOG, time: '2026-05-07T10:22:00.000Z', title: 'copy-fail (re-read)', workstreamId: WS_A_CVE },
  { url: URL_A_COPY_FAIL, time: '2026-05-07T10:25:00.000Z', title: 'copy.fail home', workstreamId: WS_A_CVE },
  { url: URL_A_GITHUB_POC, time: '2026-05-07T10:28:00.000Z', title: 'copy_fail_exp.py', workstreamId: WS_A_CVE },
  { url: URL_B_YOUTUBE, time: '2026-05-07T10:30:00.000Z', title: 'YouTube — bg', workstreamId: WS_B_SWITCHBOARD },
  { url: URL_B_CHATGPT_2, time: '2026-05-07T10:35:00.000Z', title: 'ChatGPT — Switchboard PRs', workstreamId: WS_B_SWITCHBOARD },
  { url: URL_A_CODING_THREAD, time: '2026-05-07T10:42:00.000Z', title: 'Claude — coding agent', workstreamId: WS_A_CVE },
  { url: URL_B_GEMINI, time: '2026-05-07T10:50:00.000Z', title: 'Gemini — analysis', workstreamId: WS_B_SWITCHBOARD },
];

const buildDay = (): TimelineDayProjection => {
  const byUrl = new Map<
    string,
    {
      firstSeenAt: string;
      lastSeenAt: string;
      title: string;
      visitCount: number;
      workstreamId?: string;
      workstreamObservedAt?: string;
    }
  >();
  for (const e of visits) {
    const existing = byUrl.get(e.url);
    if (existing === undefined) {
      byUrl.set(e.url, {
        firstSeenAt: e.time,
        lastSeenAt: e.time,
        title: e.title,
        visitCount: 1,
        ...(e.workstreamId === undefined
          ? {}
          : { workstreamId: e.workstreamId, workstreamObservedAt: e.time }),
      });
    } else {
      existing.lastSeenAt = e.time > existing.lastSeenAt ? e.time : existing.lastSeenAt;
      existing.firstSeenAt = e.time < existing.firstSeenAt ? e.time : existing.firstSeenAt;
      existing.visitCount += 1;
      // LWW workstreamId — most recent observation wins, mirroring
      // the production projection reducer's semantics.
      if (e.workstreamId !== undefined && e.workstreamId.length > 0) {
        if (
          existing.workstreamObservedAt === undefined ||
          e.time >= existing.workstreamObservedAt
        ) {
          existing.workstreamId = e.workstreamId;
          existing.workstreamObservedAt = e.time;
        }
      }
    }
  }
  return {
    date: '2026-05-07',
    entries: [...byUrl.entries()].map(([url, agg]) => ({
      id: url,
      firstSeenAt: agg.firstSeenAt,
      lastSeenAt: agg.lastSeenAt,
      url,
      canonicalUrl: url,
      title: agg.title,
      visitCount: agg.visitCount,
      ...(agg.workstreamId === undefined ? {} : { workstreamId: agg.workstreamId }),
    })),
    updatedAt: '2026-05-07T10:55:00.000Z',
    entryCount: byUrl.size,
  };
};

// ---------------------------------------------------------------------------
// Events log
// ---------------------------------------------------------------------------

interface RawEvent {
  readonly timeIso: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

const toAcceptedEvents = (raw: readonly RawEvent[]): AcceptedEvent[] => {
  const sorted = [...raw].sort((a, b) =>
    a.timeIso !== b.timeIso ? (a.timeIso < b.timeIso ? -1 : 1) : a.aggregateId < b.aggregateId ? -1 : 1,
  );
  return sorted.map((r, i) => ({
    clientEventId: `evt-${String(i + 1).padStart(3, '0')}`,
    dot: { replicaId: REPLICA, seq: i + 1 },
    deps: {},
    aggregateId: r.aggregateId,
    type: r.type,
    payload: r.payload,
    acceptedAtMs: Date.parse(r.timeIso),
  }));
};

const buildEvents = (): readonly AcceptedEvent[] => {
  const raw: RawEvent[] = [];

  // Workstreams
  raw.push(
    {
      timeIso: '2026-05-07T09:55:00.000Z',
      type: WORKSTREAM_UPSERTED,
      aggregateId: WS_A_CVE,
      payload: { bac_id: WS_A_CVE, title: 'Security · copy-fail CVE-2026-31431' },
    },
    {
      timeIso: '2026-05-07T09:55:30.000Z',
      type: WORKSTREAM_UPSERTED,
      aggregateId: WS_B_SWITCHBOARD,
      payload: { bac_id: WS_B_SWITCHBOARD, title: 'Switchboard · project review' },
    },
  );

  // Thread upserts
  for (const t of threads) {
    raw.push({
      timeIso: t.lastSeenAt!,
      type: THREAD_UPSERTED,
      aggregateId: t.bac_id,
      payload: {
        bac_id: t.bac_id,
        provider: t.provider,
        threadUrl: t.threadUrl,
        title: t.title,
        lastSeenAt: t.lastSeenAt,
        tags: [],
        primaryWorkstreamId: t.primaryWorkstreamId,
      },
    });
  }

  // Captures (charitable assumption about what the user pastes into chats)
  // - ChatGPT CVE thread: pastes HN + blog + github PoC URLs (a typical
  //   "here's what I'm reading, what does this mean" prompt)
  raw.push({
    timeIso: '2026-05-07T10:15:00.000Z',
    type: CAPTURE_RECORDED,
    aggregateId: T_A_CHATGPT,
    payload: {
      bac_id: T_A_CHATGPT,
      threadId: T_A_CHATGPT,
      threadUrl: URL_A_CHATGPT,
      provider: 'chatgpt',
      capturedAt: '2026-05-07T10:15:00.000Z',
      turns: [
        {
          ordinal: 0,
          role: 'user',
          text: `i'm reading ${URL_A_HN} about copy-fail. main writeup is ${URL_A_BLOG}. PoC at ${URL_A_GITHUB_POC}. explain the Linux crypto subsystem angle.`,
          capturedAt: '2026-05-07T10:15:00.000Z',
        },
        {
          ordinal: 1,
          role: 'assistant',
          text: `the relevant kernel signature is ${POC_CODE_SNIPPET}. flags are ignored, len-> page-rounded.`,
          capturedAt: '2026-05-07T10:15:00.000Z',
        },
      ],
    },
  });

  // Coding-agent thread (started by the Codex dispatch). Pastes the
  // ChatGPT assistant's snippet into its plan.
  raw.push({
    timeIso: '2026-05-07T10:50:00.000Z',
    type: CAPTURE_RECORDED,
    aggregateId: T_A_CODING,
    payload: {
      bac_id: T_A_CODING,
      threadId: T_A_CODING,
      threadUrl: URL_A_CODING_THREAD,
      provider: 'claude',
      capturedAt: '2026-05-07T10:50:00.000Z',
      turns: [
        {
          ordinal: 0,
          role: 'user',
          text: `take the PoC at ${URL_A_GITHUB_POC} and try it on the VM. relevant fn: ${POC_CODE_SNIPPET}`,
          capturedAt: '2026-05-07T10:50:00.000Z',
        },
      ],
    },
  });

  // Switchboard ChatGPT 1 — pastes the repo URL.
  raw.push({
    timeIso: '2026-05-07T10:25:00.000Z',
    type: CAPTURE_RECORDED,
    aggregateId: T_B_CHATGPT_1,
    payload: {
      bac_id: T_B_CHATGPT_1,
      threadId: T_B_CHATGPT_1,
      threadUrl: URL_B_CHATGPT_1,
      provider: 'chatgpt',
      capturedAt: '2026-05-07T10:25:00.000Z',
      turns: [
        {
          ordinal: 0,
          role: 'user',
          text: `walk me through the sync architecture in ${URL_B_GH_REPO}.`,
          capturedAt: '2026-05-07T10:25:00.000Z',
        },
        {
          ordinal: 1,
          role: 'assistant',
          text: `Switchboard uses a relay + per-replica event log. Materializers project state into vault JSON.`,
          capturedAt: '2026-05-07T10:25:00.000Z',
        },
      ],
    },
  });

  // Switchboard ChatGPT 2 — pastes the PRs URL.
  raw.push({
    timeIso: '2026-05-07T10:40:00.000Z',
    type: CAPTURE_RECORDED,
    aggregateId: T_B_CHATGPT_2,
    payload: {
      bac_id: T_B_CHATGPT_2,
      threadId: T_B_CHATGPT_2,
      threadUrl: URL_B_CHATGPT_2,
      provider: 'chatgpt',
      capturedAt: '2026-05-07T10:40:00.000Z',
      turns: [
        {
          ordinal: 0,
          role: 'user',
          text: `review the open PRs at ${URL_B_GH_PRS}. Switchboard uses a relay + per-replica event log.`,
          capturedAt: '2026-05-07T10:40:00.000Z',
        },
      ],
    },
  });

  // Gemini analysis — typically users don't paste URLs into Gemini
  // (they ask questions). So no URL refs from this thread.
  raw.push({
    timeIso: '2026-05-07T10:55:00.000Z',
    type: CAPTURE_RECORDED,
    aggregateId: T_B_GEMINI,
    payload: {
      bac_id: T_B_GEMINI,
      threadId: T_B_GEMINI,
      threadUrl: URL_B_GEMINI,
      provider: 'gemini',
      capturedAt: '2026-05-07T10:55:00.000Z',
      turns: [
        {
          ordinal: 0,
          role: 'user',
          text: `summarize the Switchboard architecture vs other CRDT-based sync systems.`,
          capturedAt: '2026-05-07T10:55:00.000Z',
        },
      ],
    },
  });

  // Dispatch to coding agent. Body cites the GitHub PoC URL.
  raw.push({
    timeIso: '2026-05-07T10:35:00.000Z',
    type: DISPATCH_RECORDED,
    aggregateId: D_A_DISPATCH_TO_CODING,
    payload: {
      bac_id: D_A_DISPATCH_TO_CODING,
      target: { provider: 'codex' },
      workstreamId: WS_A_CVE,
      createdAt: '2026-05-07T10:35:00.000Z',
      body: `try the copy-fail PoC at ${URL_A_GITHUB_POC} in a fresh VM. Goal: confirm reproducibility.`,
    },
  });

  // Annotation on the GitHub PoC page (annotation_targets_thread will
  // NOT fire since the GitHub URL isn't a thread URL — but the URL
  // itself in the note triggers annotation_references_url).
  raw.push({
    timeIso: '2026-05-07T10:30:00.000Z',
    type: ANNOTATION_CREATED,
    aggregateId: A_A_GITHUB,
    payload: {
      bac_id: A_A_GITHUB,
      url: URL_A_GITHUB_POC,
      note: `key snippet — see also ${URL_A_BLOG}`,
      anchor: {
        textQuote: { exact: 'copy_file_range', prefix: 'def ', suffix: '(' },
        textPosition: { start: 80, end: 96 },
        cssSelector: 'pre',
      },
      pageTitle: 'copy_fail_exp.py',
    },
  });

  return toAcceptedEvents(raw);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const buildRealisticFlowFixture = (): ConnectionsInput => ({
  events: buildEvents(),
  threads,
  workstreams,
  dispatches,
  queueItems: [],
  reminders: [],
  codingSessions,
  timelineDays: [buildDay()],
});

// All tracked nodes the user expected to see, grouped by flow.
// These are nodes the system COULD plausibly link, given the
// narrative — what actually links depends on the reducer.
export const REALISTIC_FLOW_A_NODES = {
  workstream: nodeIdFor('workstream', WS_A_CVE),
  threads: [nodeIdFor('thread', T_A_CHATGPT), nodeIdFor('thread', T_A_CODING)],
  dispatches: [nodeIdFor('dispatch', D_A_DISPATCH_TO_CODING)],
  codingSessions: [nodeIdFor('coding-session', CS_A_CODING)],
  annotations: [nodeIdFor('annotation', A_A_GITHUB)],
  visits: {
    hn: nodeIdFor('timeline-visit', URL_A_HN),
    blog: nodeIdFor('timeline-visit', URL_A_BLOG),
    googleSearch: nodeIdFor('timeline-visit', URL_A_GOOGLE_SEARCH),
    chatgpt: nodeIdFor('timeline-visit', URL_A_CHATGPT),
    // visit-id strips trailing slash, so 'https://copy.fail/' → 'https://copy.fail'
    copyFail: nodeIdFor('timeline-visit', URL_A_COPY_FAIL.replace(/\/+$/u, '')),
    githubPoC: nodeIdFor('timeline-visit', URL_A_GITHUB_POC),
    codingThread: nodeIdFor('timeline-visit', URL_A_CODING_THREAD),
  },
} as const;

export const REALISTIC_FLOW_B_NODES = {
  workstream: nodeIdFor('workstream', WS_B_SWITCHBOARD),
  threads: [
    nodeIdFor('thread', T_B_CHATGPT_1),
    nodeIdFor('thread', T_B_CHATGPT_2),
    nodeIdFor('thread', T_B_GEMINI),
  ],
  visits: {
    repo: nodeIdFor('timeline-visit', URL_B_GH_REPO),
    prs: nodeIdFor('timeline-visit', URL_B_GH_PRS),
    chatgpt1: nodeIdFor('timeline-visit', URL_B_CHATGPT_1),
    chatgpt2: nodeIdFor('timeline-visit', URL_B_CHATGPT_2),
    youtube: nodeIdFor('timeline-visit', URL_B_YOUTUBE),
    gemini: nodeIdFor('timeline-visit', URL_B_GEMINI),
  },
} as const;
