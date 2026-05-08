// Multi-flow user-story fixture for Connections integration tests.
//
// Three parallel research flows, woven by acceptedAtMs so no flow is
// contiguous in the event log:
//
//   Flow A — copy-fail Linux CVE        (workstream ws_security)
//   Flow B — Postgres MERGE / UPSERT    (workstream ws_postgres)
//   Flow C — Switchboard project review (workstream ws_sidetrack)
//
// One intentional cross-flow URL coincidence:
//   `news.ycombinator.com/item?id=42_pgmerge` is visited by Flow B
//   AND referenced in user turns of both `t_pg_claude` and `t_sb_claude`.
//   That visit therefore bridges flows B and C — exactly the messy-
//   parallel-flows case the user described in conversation.
//
// Workstream parent chain: ws_security has parent ws_research, so
// 2-hop subgraph from ws_security includes ws_research.
//
// The fixture also exports an `EXPECTED` struct describing each flow's
// nodes and the cross-flow shared nodes — tests use these to
// programmatically derive expected subgraph membership rather than
// hand-listing nodes (which would rot).

import { ANNOTATION_CREATED } from '../../annotations/events.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import { QUEUE_CREATED } from '../../queue/events.js';
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
  QueueVaultRecord,
  ReminderVaultRecord,
  ThreadVaultRecord,
  WorkstreamVaultRecord,
} from '../snapshot.js';

// ---------------------------------------------------------------------------
// URLs (used as both timeline visit canonical URLs and as references
// embedded in turn text / dispatch bodies / annotation notes).
// ---------------------------------------------------------------------------

// Flow A
const URL_HN_COPYFAIL = 'https://news.ycombinator.com/item?id=42_copyfail';
const URL_XINT_BLOG = 'https://xint.io/blog/copy-fail-linux-distributions';
const URL_GOOGLE_CVE = 'https://www.google.com/search?q=linux+copy_file_range+CVE';
const URL_KERNEL_DOC = 'https://kernel.org/doc/man-pages/online/copy_file_range.2.html';
const URL_NVD_CVE = 'https://nvd.nist.gov/vuln/detail/CVE-2024-12345';
const URL_CLAUDE_CVE = 'https://claude.ai/chat/cve_thread';
const URL_CHATGPT_CVE = 'https://chatgpt.com/c/cve_review';

// Flow B
const URL_HN_PGMERGE = 'https://news.ycombinator.com/item?id=42_pgmerge';
const URL_PG_BLOG = 'https://blog.example.com/merge-pitfalls';
const URL_PG_DOCS = 'https://www.postgresql.org/docs/current/sql-merge.html';
const URL_CLAUDE_PG = 'https://claude.ai/chat/pg_thread';
const URL_CHATGPT_PG = 'https://chatgpt.com/c/pg_review';

// Flow C
const URL_GH_PR = 'https://github.com/sidetrack-co/sidetrack/pull/98';
const URL_GH_BRAINSTORM = 'https://github.com/sidetrack-co/sidetrack/blob/main/BRAINSTORM.md';
const URL_CLAUDE_SB = 'https://claude.ai/chat/sb_thread';
const URL_CHATGPT_SB = 'https://chatgpt.com/c/sb_review';

// ---------------------------------------------------------------------------
// Aggregate ids (deterministic across runs)
// ---------------------------------------------------------------------------

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

const D_CVE_CODEX = 'd_cve_codex';
const D_PG_CODEX = 'd_pg_codex';
const D_SB_REFACTOR = 'd_sb_refactor';

const CS_CVE_VM = 'cs_cve_vm';
const CS_SB_REFACTOR = 'cs_sb_refactor';

const Q_CVE_WS = 'q_cve_ws';
const Q_PG_T = 'q_pg_t';

const R_CVE_T = 'r_cve_t';

const A_CVE_KERNEL = 'a_cve_kernel';
const A_CVE_THREAD = 'a_cve_thread';
const A_PG_DOC = 'a_pg_doc';
const A_SB_BRAINSTORM = 'a_sb_brainstorm';

// ---------------------------------------------------------------------------
// Shared 60+ char code/SQL blocks used to trigger thread_quotes_thread
// (must be ≥40 chars after whitespace normalization to produce ≥4
// contiguous shingles).
// ---------------------------------------------------------------------------

const PYTHON_REPRO_BLOCK =
  'import os\nfd = os.open("/tmp/probe", os.O_RDONLY)\ndata = os.copy_file_range(fd, fd2, 4096, 0)';
const SQL_MERGE_BLOCK =
  'MERGE INTO accounts a USING new_balances n ON a.id = n.id WHEN MATCHED THEN UPDATE SET balance=n.balance';
const REDUCER_TS_BLOCK =
  'export const buildConnectionsSnapshot = (input: ConnectionsInput): ConnectionsSnapshot => {';

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const REPLICA = 'replica-mac';

const parseTime = (iso: string): number => Date.parse(iso);

interface RawEvent {
  readonly timeIso: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

// Builds AcceptedEvents in temporal order, assigning monotonic seq
// per replica. The fixture's seq numbers depend on the sort order so
// the reducer's idempotency rules apply correctly.
const toAcceptedEvents = (raw: readonly RawEvent[]): AcceptedEvent[] => {
  const sorted = [...raw].sort((a, b) => {
    if (a.timeIso !== b.timeIso) return a.timeIso < b.timeIso ? -1 : 1;
    return a.aggregateId < b.aggregateId ? -1 : a.aggregateId > b.aggregateId ? 1 : 0;
  });
  return sorted.map((r, i) => ({
    clientEventId: `evt-${String(i + 1).padStart(3, '0')}`,
    dot: { replicaId: REPLICA, seq: i + 1 },
    deps: {},
    aggregateId: r.aggregateId,
    type: r.type,
    payload: r.payload,
    acceptedAtMs: parseTime(r.timeIso),
  }));
};

// ---------------------------------------------------------------------------
// Vault records (current materialized projection state)
// ---------------------------------------------------------------------------

const workstreams: readonly WorkstreamVaultRecord[] = [
  { bac_id: WS_RESEARCH, title: 'Research', children: [WS_SECURITY] },
  { bac_id: WS_SECURITY, title: 'Security · Linux CVE', parentId: WS_RESEARCH },
  { bac_id: WS_POSTGRES, title: 'Postgres · MERGE semantics' },
  { bac_id: WS_SIDETRACK, title: 'Sidetrack · project review' },
];

const threads: readonly ThreadVaultRecord[] = [
  {
    bac_id: T_CVE_CLAUDE,
    title: 'Claude — copy_file_range CVE',
    threadUrl: URL_CLAUDE_CVE,
    canonicalUrl: URL_CLAUDE_CVE,
    provider: 'claude',
    primaryWorkstreamId: WS_SECURITY,
    lastSeenAt: '2026-05-07T09:18:00.000Z',
  },
  {
    bac_id: T_CVE_CHATGPT,
    title: 'ChatGPT — review CVE repro',
    threadUrl: URL_CHATGPT_CVE,
    canonicalUrl: URL_CHATGPT_CVE,
    provider: 'chatgpt',
    primaryWorkstreamId: WS_SECURITY,
    lastSeenAt: '2026-05-07T09:30:00.000Z',
  },
  {
    bac_id: T_PG_CLAUDE,
    title: 'Claude — MERGE vs UPSERT',
    threadUrl: URL_CLAUDE_PG,
    canonicalUrl: URL_CLAUDE_PG,
    provider: 'claude',
    primaryWorkstreamId: WS_POSTGRES,
    lastSeenAt: '2026-05-07T09:24:00.000Z',
  },
  {
    bac_id: T_PG_CHATGPT,
    title: 'ChatGPT — review SQL plan',
    threadUrl: URL_CHATGPT_PG,
    canonicalUrl: URL_CHATGPT_PG,
    provider: 'chatgpt',
    primaryWorkstreamId: WS_POSTGRES,
    lastSeenAt: '2026-05-07T09:28:00.000Z',
  },
  {
    bac_id: T_SB_CLAUDE,
    title: 'Claude — m2 dispatch design review',
    threadUrl: URL_CLAUDE_SB,
    canonicalUrl: URL_CLAUDE_SB,
    provider: 'claude',
    primaryWorkstreamId: WS_SIDETRACK,
    lastSeenAt: '2026-05-07T09:19:00.000Z',
  },
  {
    bac_id: T_SB_CHATGPT,
    title: 'ChatGPT — review reducer code',
    threadUrl: URL_CHATGPT_SB,
    canonicalUrl: URL_CHATGPT_SB,
    provider: 'chatgpt',
    primaryWorkstreamId: WS_SIDETRACK,
    lastSeenAt: '2026-05-07T09:31:00.000Z',
  },
];

const dispatches: readonly DispatchVaultRecord[] = [
  {
    bac_id: D_CVE_CODEX,
    title: 'Codex — Python repro for CVE-2024-12345',
    target: { provider: 'codex' },
    status: 'sent',
    createdAt: '2026-05-07T09:22:00.000Z',
    sourceThreadId: T_CVE_CLAUDE,
    workstreamId: WS_SECURITY,
    mcpRequest: { codingSessionId: CS_CVE_VM },
  },
  {
    bac_id: D_PG_CODEX,
    title: 'Codex — refactor migration to ON CONFLICT',
    target: { provider: 'codex' },
    status: 'sent',
    createdAt: '2026-05-07T09:32:00.000Z',
    sourceThreadId: T_PG_CLAUDE,
    workstreamId: WS_POSTGRES,
  },
  {
    bac_id: D_SB_REFACTOR,
    title: 'Claude Code — refactor reducer pass-2',
    target: { provider: 'claude_code' },
    status: 'sent',
    createdAt: '2026-05-07T09:24:00.000Z',
    sourceThreadId: T_SB_CLAUDE,
    workstreamId: WS_SIDETRACK,
    mcpRequest: { codingSessionId: CS_SB_REFACTOR },
  },
];

const codingSessions: readonly CodingSessionVaultRecord[] = [
  {
    bac_id: CS_CVE_VM,
    workstreamId: WS_SECURITY,
    tool: 'codex',
    cwd: '/work/cve-repro',
    name: 'cve-vm',
    attachedAt: '2026-05-07T09:25:00.000Z',
    lastSeenAt: '2026-05-07T09:42:00.000Z',
    status: 'attached',
  },
  {
    bac_id: CS_SB_REFACTOR,
    workstreamId: WS_SIDETRACK,
    tool: 'claude_code',
    cwd: '/work/sidetrack',
    name: 'sidetrack-refactor',
    attachedAt: '2026-05-07T09:27:00.000Z',
    lastSeenAt: '2026-05-07T09:42:00.000Z',
    status: 'attached',
  },
];

const queueItems: readonly QueueVaultRecord[] = [
  {
    bac_id: Q_CVE_WS,
    title: 'test repro on Ubuntu 22 + 24',
    scope: 'workstream',
    targetId: WS_SECURITY,
    status: 'pending',
    createdAt: '2026-05-07T09:38:00.000Z',
    workstreamId: WS_SECURITY,
  },
  {
    bac_id: Q_PG_T,
    title: 'document MERGE isolation pitfall',
    scope: 'thread',
    targetId: T_PG_CLAUDE,
    status: 'pending',
    createdAt: '2026-05-07T09:35:00.000Z',
    threadId: T_PG_CLAUDE,
  },
];

const reminders: readonly ReminderVaultRecord[] = [
  {
    bac_id: R_CVE_T,
    threadId: T_CVE_CLAUDE,
    provider: 'claude',
    detectedAt: '2026-05-07T09:42:00.000Z',
    status: 'new',
  },
];

// ---------------------------------------------------------------------------
// Timeline day projection — every visit lands here.
// ---------------------------------------------------------------------------

const timelineEntries = [
  { url: URL_HN_COPYFAIL, time: '2026-05-07T09:00:00.000Z', title: 'HN: copy-fail breaks distros' },
  { url: URL_GH_PR, time: '2026-05-07T09:05:00.000Z', title: 'sidetrack/sidetrack PR #98' },
  { url: URL_XINT_BLOG, time: '2026-05-07T09:05:30.000Z', title: 'copy-fail across linux distros' },
  { url: URL_GOOGLE_CVE, time: '2026-05-07T09:08:00.000Z', title: 'Google: linux copy_file_range CVE' },
  { url: URL_KERNEL_DOC, time: '2026-05-07T09:10:00.000Z', title: 'man copy_file_range(2)' },
  { url: URL_GH_BRAINSTORM, time: '2026-05-07T09:11:00.000Z', title: 'BRAINSTORM.md' },
  { url: URL_HN_PGMERGE, time: '2026-05-07T09:12:00.000Z', title: 'HN: postgres MERGE pitfalls' },
  { url: URL_NVD_CVE, time: '2026-05-07T09:14:00.000Z', title: 'NVD CVE-2024-12345' },
  { url: URL_PG_BLOG, time: '2026-05-07T09:15:00.000Z', title: 'MERGE pitfalls (blog)' },
  // cross-flow! Flow C user also lands on the pgmerge HN thread
  { url: URL_HN_PGMERGE, time: '2026-05-07T09:16:00.000Z', title: 'HN: postgres MERGE pitfalls' },
  { url: URL_CLAUDE_CVE, time: '2026-05-07T09:18:00.000Z', title: 'Claude — CVE chat' },
  { url: URL_CLAUDE_SB, time: '2026-05-07T09:18:30.000Z', title: 'Claude — sb chat' },
  { url: URL_PG_DOCS, time: '2026-05-07T09:20:00.000Z', title: 'PostgreSQL: MERGE' },
  { url: URL_CLAUDE_PG, time: '2026-05-07T09:23:00.000Z', title: 'Claude — pg chat' },
  { url: URL_CHATGPT_PG, time: '2026-05-07T09:27:00.000Z', title: 'ChatGPT — pg review' },
  { url: URL_CHATGPT_CVE, time: '2026-05-07T09:29:00.000Z', title: 'ChatGPT — cve review' },
  { url: URL_CHATGPT_SB, time: '2026-05-07T09:30:30.000Z', title: 'ChatGPT — sb review' },
];

// Aggregate visits by URL into one TimelineEntry each (the projection
// reducer would do this naturally; we approximate it here).
const buildDay = (): TimelineDayProjection => {
  const byUrl = new Map<
    string,
    { firstSeenAt: string; lastSeenAt: string; title?: string; visitCount: number }
  >();
  for (const e of timelineEntries) {
    const existing = byUrl.get(e.url);
    if (existing === undefined) {
      byUrl.set(e.url, {
        firstSeenAt: e.time,
        lastSeenAt: e.time,
        title: e.title,
        visitCount: 1,
      });
    } else {
      existing.lastSeenAt = e.time > existing.lastSeenAt ? e.time : existing.lastSeenAt;
      existing.firstSeenAt = e.time < existing.firstSeenAt ? e.time : existing.firstSeenAt;
      existing.visitCount += 1;
    }
  }
  const entries = [...byUrl.entries()].map(([url, agg]) => ({
    id: url,
    firstSeenAt: agg.firstSeenAt,
    lastSeenAt: agg.lastSeenAt,
    url,
    canonicalUrl: url,
    ...(agg.title === undefined ? {} : { title: agg.title }),
    visitCount: agg.visitCount,
  }));
  return {
    date: '2026-05-07',
    entries,
    updatedAt: '2026-05-07T09:42:00.000Z',
    entryCount: entries.length,
  };
};

// ---------------------------------------------------------------------------
// Events log (woven temporally)
// ---------------------------------------------------------------------------

const buildEvents = (): readonly AcceptedEvent[] => {
  const raw: RawEvent[] = [];

  // Workstream upserts (early bookkeeping)
  raw.push(
    {
      timeIso: '2026-05-07T08:55:00.000Z',
      type: WORKSTREAM_UPSERTED,
      aggregateId: WS_RESEARCH,
      payload: { bac_id: WS_RESEARCH, title: 'Research' },
    },
    {
      timeIso: '2026-05-07T08:56:00.000Z',
      type: WORKSTREAM_UPSERTED,
      aggregateId: WS_SECURITY,
      payload: { bac_id: WS_SECURITY, title: 'Security · Linux CVE', parentId: WS_RESEARCH },
    },
    {
      timeIso: '2026-05-07T08:57:00.000Z',
      type: WORKSTREAM_UPSERTED,
      aggregateId: WS_POSTGRES,
      payload: { bac_id: WS_POSTGRES, title: 'Postgres · MERGE semantics' },
    },
    {
      timeIso: '2026-05-07T08:58:00.000Z',
      type: WORKSTREAM_UPSERTED,
      aggregateId: WS_SIDETRACK,
      payload: { bac_id: WS_SIDETRACK, title: 'Sidetrack · project review' },
    },
  );

  // Thread upserts (each in its own workstream, near the time of capture)
  raw.push(
    {
      timeIso: '2026-05-07T09:18:00.000Z',
      type: THREAD_UPSERTED,
      aggregateId: T_CVE_CLAUDE,
      payload: {
        bac_id: T_CVE_CLAUDE,
        provider: 'claude',
        threadUrl: URL_CLAUDE_CVE,
        title: 'Claude — copy_file_range CVE',
        lastSeenAt: '2026-05-07T09:18:00.000Z',
        tags: [],
        primaryWorkstreamId: WS_SECURITY,
      },
    },
    {
      timeIso: '2026-05-07T09:30:00.000Z',
      type: THREAD_UPSERTED,
      aggregateId: T_CVE_CHATGPT,
      payload: {
        bac_id: T_CVE_CHATGPT,
        provider: 'chatgpt',
        threadUrl: URL_CHATGPT_CVE,
        title: 'ChatGPT — review CVE repro',
        lastSeenAt: '2026-05-07T09:30:00.000Z',
        tags: [],
        primaryWorkstreamId: WS_SECURITY,
      },
    },
    {
      timeIso: '2026-05-07T09:24:00.000Z',
      type: THREAD_UPSERTED,
      aggregateId: T_PG_CLAUDE,
      payload: {
        bac_id: T_PG_CLAUDE,
        provider: 'claude',
        threadUrl: URL_CLAUDE_PG,
        title: 'Claude — MERGE vs UPSERT',
        lastSeenAt: '2026-05-07T09:24:00.000Z',
        tags: [],
        primaryWorkstreamId: WS_POSTGRES,
      },
    },
    {
      timeIso: '2026-05-07T09:28:00.000Z',
      type: THREAD_UPSERTED,
      aggregateId: T_PG_CHATGPT,
      payload: {
        bac_id: T_PG_CHATGPT,
        provider: 'chatgpt',
        threadUrl: URL_CHATGPT_PG,
        title: 'ChatGPT — review SQL plan',
        lastSeenAt: '2026-05-07T09:28:00.000Z',
        tags: [],
        primaryWorkstreamId: WS_POSTGRES,
      },
    },
    {
      timeIso: '2026-05-07T09:19:00.000Z',
      type: THREAD_UPSERTED,
      aggregateId: T_SB_CLAUDE,
      payload: {
        bac_id: T_SB_CLAUDE,
        provider: 'claude',
        threadUrl: URL_CLAUDE_SB,
        title: 'Claude — m2 dispatch design review',
        lastSeenAt: '2026-05-07T09:19:00.000Z',
        tags: [],
        primaryWorkstreamId: WS_SIDETRACK,
      },
    },
    {
      timeIso: '2026-05-07T09:31:00.000Z',
      type: THREAD_UPSERTED,
      aggregateId: T_SB_CHATGPT,
      payload: {
        bac_id: T_SB_CHATGPT,
        provider: 'chatgpt',
        threadUrl: URL_CHATGPT_SB,
        title: 'ChatGPT — review reducer code',
        lastSeenAt: '2026-05-07T09:31:00.000Z',
        tags: [],
        primaryWorkstreamId: WS_SIDETRACK,
      },
    },
  );

  // Capture events — each thread's user turn pastes URLs that are
  // also in the timeline → thread_references_url. Assistant turns
  // contain the shared code block to set up thread_quotes_thread.
  raw.push(
    {
      timeIso: '2026-05-07T09:18:00.000Z',
      type: CAPTURE_RECORDED,
      aggregateId: T_CVE_CLAUDE,
      payload: {
        bac_id: T_CVE_CLAUDE,
        threadUrl: URL_CLAUDE_CVE,
        provider: 'claude',
        capturedAt: '2026-05-07T09:18:00.000Z',
        turns: [
          {
            ordinal: 0,
            role: 'user',
            text: `i'm reading ${URL_HN_COPYFAIL} plus the ${URL_XINT_BLOG} writeup. NVD says ${URL_NVD_CVE}. explain the linux copy_file_range CVE socket angle.`,
          },
          {
            ordinal: 1,
            role: 'assistant',
            text: `here's a Python reproducer:\n${PYTHON_REPRO_BLOCK}\nthat exercises the bug.`,
          },
        ],
      },
    },
    {
      timeIso: '2026-05-07T09:30:00.000Z',
      type: CAPTURE_RECORDED,
      aggregateId: T_CVE_CHATGPT,
      payload: {
        bac_id: T_CVE_CHATGPT,
        threadUrl: URL_CHATGPT_CVE,
        provider: 'chatgpt',
        capturedAt: '2026-05-07T09:30:00.000Z',
        turns: [
          {
            ordinal: 0,
            role: 'user',
            text: `please audit this:\n${PYTHON_REPRO_BLOCK}\nis it sound?`,
          },
        ],
      },
    },
    {
      timeIso: '2026-05-07T09:24:00.000Z',
      type: CAPTURE_RECORDED,
      aggregateId: T_PG_CLAUDE,
      payload: {
        bac_id: T_PG_CLAUDE,
        threadUrl: URL_CLAUDE_PG,
        provider: 'claude',
        capturedAt: '2026-05-07T09:24:00.000Z',
        turns: [
          {
            ordinal: 0,
            role: 'user',
            text: `context: ${URL_HN_PGMERGE}, ${URL_PG_BLOG}, ${URL_PG_DOCS}. compare MERGE vs INSERT ON CONFLICT for our use case.`,
          },
          {
            ordinal: 1,
            role: 'assistant',
            text: `concrete example:\n${SQL_MERGE_BLOCK}\n— note the isolation pitfall.`,
          },
        ],
      },
    },
    {
      timeIso: '2026-05-07T09:28:00.000Z',
      type: CAPTURE_RECORDED,
      aggregateId: T_PG_CHATGPT,
      payload: {
        bac_id: T_PG_CHATGPT,
        threadUrl: URL_CHATGPT_PG,
        provider: 'chatgpt',
        capturedAt: '2026-05-07T09:28:00.000Z',
        turns: [
          {
            ordinal: 0,
            role: 'user',
            text: `review this query for concurrent safety:\n${SQL_MERGE_BLOCK}`,
          },
        ],
      },
    },
    {
      timeIso: '2026-05-07T09:19:00.000Z',
      type: CAPTURE_RECORDED,
      aggregateId: T_SB_CLAUDE,
      payload: {
        bac_id: T_SB_CLAUDE,
        threadUrl: URL_CLAUDE_SB,
        provider: 'claude',
        capturedAt: '2026-05-07T09:19:00.000Z',
        turns: [
          {
            ordinal: 0,
            role: 'user',
            text: `reviewing ${URL_GH_PR} and the design at ${URL_GH_BRAINSTORM}. also see the HN backref ${URL_HN_PGMERGE}.`,
          },
          {
            ordinal: 1,
            role: 'assistant',
            text: `proposed shape:\n${REDUCER_TS_BLOCK}\n  // pass 1, pass 2, pass 3 — same idempotency rules.`,
          },
        ],
      },
    },
    {
      timeIso: '2026-05-07T09:31:00.000Z',
      type: CAPTURE_RECORDED,
      aggregateId: T_SB_CHATGPT,
      payload: {
        bac_id: T_SB_CHATGPT,
        threadUrl: URL_CHATGPT_SB,
        provider: 'chatgpt',
        capturedAt: '2026-05-07T09:31:00.000Z',
        turns: [
          {
            ordinal: 0,
            role: 'user',
            text: `please review this sketch:\n${REDUCER_TS_BLOCK}\n  // is the type correct?`,
          },
        ],
      },
    },
  );

  // Dispatch events
  raw.push(
    {
      timeIso: '2026-05-07T09:22:00.000Z',
      type: DISPATCH_RECORDED,
      aggregateId: D_CVE_CODEX,
      payload: {
        bac_id: D_CVE_CODEX,
        target: { provider: 'codex' },
        workstreamId: WS_SECURITY,
        createdAt: '2026-05-07T09:22:00.000Z',
        body: `please write a Python repro for ${URL_NVD_CVE}; checkpoint at boundary conditions.`,
      },
    },
    {
      timeIso: '2026-05-07T09:32:00.000Z',
      type: DISPATCH_RECORDED,
      aggregateId: D_PG_CODEX,
      payload: {
        bac_id: D_PG_CODEX,
        target: { provider: 'codex' },
        workstreamId: WS_POSTGRES,
        createdAt: '2026-05-07T09:32:00.000Z',
        body: `refactor migration; reference ${URL_PG_BLOG} for the failure mode.`,
      },
    },
    {
      timeIso: '2026-05-07T09:24:00.000Z',
      type: DISPATCH_RECORDED,
      aggregateId: D_SB_REFACTOR,
      payload: {
        bac_id: D_SB_REFACTOR,
        target: { provider: 'claude_code' },
        workstreamId: WS_SIDETRACK,
        createdAt: '2026-05-07T09:24:00.000Z',
        body: `refactor pass-2 per ${URL_GH_BRAINSTORM} §27.`,
      },
    },
  );

  // Dispatch.linked — the codex repro reply landed back in the
  // ChatGPT review thread (rare but realistic when the user pastes
  // the codex response into ChatGPT for a second opinion).
  raw.push({
    timeIso: '2026-05-07T09:33:00.000Z',
    type: DISPATCH_LINKED,
    aggregateId: D_CVE_CODEX,
    payload: { dispatchId: D_CVE_CODEX, threadId: T_CVE_CHATGPT },
  });

  // Queue events
  raw.push(
    {
      timeIso: '2026-05-07T09:38:00.000Z',
      type: QUEUE_CREATED,
      aggregateId: Q_CVE_WS,
      payload: {
        bac_id: Q_CVE_WS,
        text: 'test repro on Ubuntu 22 + 24',
        scope: 'workstream',
        targetId: WS_SECURITY,
        status: 'pending',
      },
    },
    {
      timeIso: '2026-05-07T09:35:00.000Z',
      type: QUEUE_CREATED,
      aggregateId: Q_PG_T,
      payload: {
        bac_id: Q_PG_T,
        text: 'document MERGE isolation pitfall',
        scope: 'thread',
        targetId: T_PG_CLAUDE,
        status: 'pending',
      },
    },
  );

  // Annotation events — a_cve_thread targets the Claude thread URL
  // (annotation_targets_thread), a_cve_kernel + a_pg_doc cite a URL
  // in their note (annotation_references_url).
  raw.push(
    {
      timeIso: '2026-05-07T09:35:30.000Z',
      type: ANNOTATION_CREATED,
      aggregateId: A_CVE_KERNEL,
      payload: {
        bac_id: A_CVE_KERNEL,
        url: URL_KERNEL_DOC,
        note: `the unsafe path is here. cross-ref ${URL_NVD_CVE}.`,
        anchor: {
          textQuote: { exact: 'EINVAL', prefix: 'returns ', suffix: ' on bad fd' },
          textPosition: { start: 1024, end: 1030 },
          cssSelector: 'pre',
        },
        pageTitle: 'man copy_file_range',
      },
    },
    {
      timeIso: '2026-05-07T09:35:45.000Z',
      type: ANNOTATION_CREATED,
      aggregateId: A_CVE_THREAD,
      payload: {
        bac_id: A_CVE_THREAD,
        url: URL_CLAUDE_CVE,
        note: 'check assistant assumed AF_UNIX abstract namespace',
        anchor: {
          textQuote: { exact: 'AF_UNIX', prefix: 'when ', suffix: ' sockets' },
          textPosition: { start: 200, end: 207 },
          cssSelector: 'p',
        },
        pageTitle: 'Claude — CVE chat',
      },
    },
    {
      timeIso: '2026-05-07T09:36:00.000Z',
      type: ANNOTATION_CREATED,
      aggregateId: A_PG_DOC,
      payload: {
        bac_id: A_PG_DOC,
        url: URL_PG_DOCS,
        note: `note: see ${URL_PG_BLOG} for the failure mode.`,
        anchor: {
          textQuote: { exact: 'isolation', prefix: 'see ', suffix: ' levels' },
          textPosition: { start: 500, end: 509 },
          cssSelector: 'section',
        },
        pageTitle: 'PostgreSQL: MERGE',
      },
    },
    {
      timeIso: '2026-05-07T09:35:00.000Z',
      type: ANNOTATION_CREATED,
      aggregateId: A_SB_BRAINSTORM,
      payload: {
        bac_id: A_SB_BRAINSTORM,
        url: URL_GH_BRAINSTORM,
        note: 'needs §27 cross-ref to BRAINSTORM',
        anchor: {
          textQuote: { exact: 'reducer', prefix: 'the ', suffix: ' is pure' },
          textPosition: { start: 80, end: 87 },
          cssSelector: 'h2',
        },
        pageTitle: 'BRAINSTORM.md',
      },
    },
  );

  // Timeline observations — one event per visit (timestamp of visit).
  for (const e of timelineEntries) {
    raw.push({
      timeIso: e.time,
      type: 'browser.timeline.observed',
      aggregateId: `2026-05-07`,
      payload: {
        url: e.url,
        canonicalUrl: e.url,
        title: e.title,
        observedAt: e.time,
        transition: 'activated',
      },
    });
  }

  return toAcceptedEvents(raw);
};

// ---------------------------------------------------------------------------
// Public fixture builder + EXPECTED struct
// ---------------------------------------------------------------------------

export const buildMultiFlowFixture = (): ConnectionsInput => ({
  events: buildEvents(),
  threads,
  workstreams,
  dispatches,
  queueItems,
  reminders,
  codingSessions,
  timelineDays: [buildDay()],
});

// Per-flow node-id catalogues. Tests use these to derive expected
// subgraph membership without hand-listing edges.
export const FLOW_NODES = {
  A: {
    workstream: nodeIdFor('workstream', WS_SECURITY),
    parentWorkstream: nodeIdFor('workstream', WS_RESEARCH),
    threads: [nodeIdFor('thread', T_CVE_CLAUDE), nodeIdFor('thread', T_CVE_CHATGPT)],
    dispatches: [nodeIdFor('dispatch', D_CVE_CODEX)],
    codingSessions: [nodeIdFor('coding-session', CS_CVE_VM)],
    queueItems: [nodeIdFor('queue-item', Q_CVE_WS)],
    reminders: [nodeIdFor('inbound-reminder', R_CVE_T)],
    annotations: [nodeIdFor('annotation', A_CVE_KERNEL), nodeIdFor('annotation', A_CVE_THREAD)],
    visits: [
      nodeIdFor('timeline-visit', URL_HN_COPYFAIL),
      nodeIdFor('timeline-visit', URL_XINT_BLOG),
      nodeIdFor('timeline-visit', URL_GOOGLE_CVE),
      nodeIdFor('timeline-visit', URL_KERNEL_DOC),
      nodeIdFor('timeline-visit', URL_NVD_CVE),
      nodeIdFor('timeline-visit', URL_CLAUDE_CVE),
      nodeIdFor('timeline-visit', URL_CHATGPT_CVE),
    ],
  },
  B: {
    workstream: nodeIdFor('workstream', WS_POSTGRES),
    threads: [nodeIdFor('thread', T_PG_CLAUDE), nodeIdFor('thread', T_PG_CHATGPT)],
    dispatches: [nodeIdFor('dispatch', D_PG_CODEX)],
    codingSessions: [],
    queueItems: [nodeIdFor('queue-item', Q_PG_T)],
    annotations: [nodeIdFor('annotation', A_PG_DOC)],
    visits: [
      nodeIdFor('timeline-visit', URL_PG_BLOG),
      nodeIdFor('timeline-visit', URL_PG_DOCS),
      nodeIdFor('timeline-visit', URL_CLAUDE_PG),
      nodeIdFor('timeline-visit', URL_CHATGPT_PG),
    ],
  },
  C: {
    workstream: nodeIdFor('workstream', WS_SIDETRACK),
    threads: [nodeIdFor('thread', T_SB_CLAUDE), nodeIdFor('thread', T_SB_CHATGPT)],
    dispatches: [nodeIdFor('dispatch', D_SB_REFACTOR)],
    codingSessions: [nodeIdFor('coding-session', CS_SB_REFACTOR)],
    queueItems: [],
    annotations: [nodeIdFor('annotation', A_SB_BRAINSTORM)],
    visits: [
      nodeIdFor('timeline-visit', URL_GH_PR),
      nodeIdFor('timeline-visit', URL_GH_BRAINSTORM),
      nodeIdFor('timeline-visit', URL_CLAUDE_SB),
      nodeIdFor('timeline-visit', URL_CHATGPT_SB),
    ],
  },
} as const;

// Cross-flow shared nodes — visits that legitimately appear in
// multiple flows' subgraphs (because both flows reference or visit
// them).
export const CROSS_FLOW_NODES = {
  hnPgMergeVisit: nodeIdFor('timeline-visit', URL_HN_PGMERGE),
} as const;

// Full set of flow-exclusive nodes — what should NEVER appear in
// another flow's neighborhood. Excludes cross-flow shared visits.
export const flowExclusiveNodes = (flow: 'A' | 'B' | 'C'): readonly string[] => {
  const f = FLOW_NODES[flow];
  const list: string[] = [
    f.workstream,
    ...f.threads,
    ...f.dispatches,
    ...f.codingSessions,
    ...f.queueItems,
    ...('reminders' in f ? f.reminders : []),
    ...f.annotations,
    ...f.visits,
  ];
  if ('parentWorkstream' in f && f.parentWorkstream !== undefined) list.push(f.parentWorkstream);
  return list;
};

// Convenience for tests that need the exact ids without re-deriving.
export const NODE_IDS = {
  WS_RESEARCH: nodeIdFor('workstream', WS_RESEARCH),
  WS_SECURITY: nodeIdFor('workstream', WS_SECURITY),
  WS_POSTGRES: nodeIdFor('workstream', WS_POSTGRES),
  WS_SIDETRACK: nodeIdFor('workstream', WS_SIDETRACK),
  T_CVE_CLAUDE: nodeIdFor('thread', T_CVE_CLAUDE),
  T_CVE_CHATGPT: nodeIdFor('thread', T_CVE_CHATGPT),
  T_PG_CLAUDE: nodeIdFor('thread', T_PG_CLAUDE),
  T_PG_CHATGPT: nodeIdFor('thread', T_PG_CHATGPT),
  T_SB_CLAUDE: nodeIdFor('thread', T_SB_CLAUDE),
  T_SB_CHATGPT: nodeIdFor('thread', T_SB_CHATGPT),
  HN_PGMERGE_VISIT: nodeIdFor('timeline-visit', URL_HN_PGMERGE),
  HN_COPYFAIL_VISIT: nodeIdFor('timeline-visit', URL_HN_COPYFAIL),
} as const;
