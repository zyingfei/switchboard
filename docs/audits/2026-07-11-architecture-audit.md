# Sidetrack architecture audit + roadmap — 2026-07-11

**Method**: 72-agent multi-phase workflow. Phase 1 mapped 6 subsystems in
parallel plus a requirement-by-requirement coverage table against PRD.md
P0/P0.5. Phase 2 hunted issues through 8 independent lenses (modularity,
performance, integrity, reliability, security, product-gap, testing,
evolution), every finding required to cite file:line from current code.
Phase 3 deduplicated 61 raw findings to 35 canonical and adversarially
verified each one (high-severity got two independent verifiers — evidence
correctness + business impact); all 35 survived, 0 rejected. Phase 4 had
three roadmap designers work from different strategic angles
(mvp-first / stability-first / leverage-reality), scored by a judge that
synthesized the recommended roadmap. Branch audited:
`feat/recall-ranker-v2-replacement` @ `60369f18`.

## Executive summary

The locked architecture anchors are respected — vault-canonical state,
companion as sole writer, extension as sensor+UI, MCP as reader. The
issues cluster into four themes:

1. **The §24.10 safety chain is implemented backwards** (F01, F02, F04,
   F03). Redaction runs on the *stored audit copy* while every
   user-facing outbound path (clipboard copy, auto-send, redispatch)
   ships the raw text — the exact inverse of the PRD's ship-blocking
   requirement. MCP write-trust is voluntary-header-based and
   allow-by-default; the audit schema can't attribute agent writes. New
   workstreams default to privacy-open. These are mostly S/M fixes.

2. **The MVP fails on days-scale gaps while P1 systems absorbed months**
   (F05, F06). The PRD §13 acceptance scenario hard-fails at steps 7, 9,
   11, 13 — each a missing UI view or route whose backend already
   exists. Meanwhile ~63k LOC of post-MVP P1 capability (connections
   graph, hybrid vector recall, learned ranker) compounds on the branch.
   Reality also over-delivered: hybrid recall, persistent annotation,
   and the suggestion layer arrived early and work in daily dogfood —
   the PRD needs amending, not just the code.

3. **Data-lifecycle walls** (F09–F12, F20, F24–F26). Event data grows
   ~9–10 MB/day with no compaction (93% engagement telemetry); the
   default read architecture materializes the whole log in JS heap with
   the typed SQLite path env-gated off; the replica seq counter is never
   reconciled at boot (dot-reuse can poison the causal log); the
   extension capture outbox can silently lose explicit captures in SW
   races; no fsync anywhere in the acknowledged write path.

4. **The engineering system can't protect any of it** (F14–F17, F07,
   F08). Six weeks of work unpushed on one branch, zero CI, the declared
   companion test runner silently skips the SQLite persistence suites, a
   13-fail extension baseline is normalized, no perf regression harness
   despite perf being the dominant historical failure mode, and ~90% of
   the live API surface has no enforced contract.

**Recommended strategy** (judge winner: mvp-first skeleton + grafts):
days-scale protection (push, CI, green baseline, data-loss/privacy
patches, PRD reality-amendment) → weeks 2–4 safety-chain inversion +
§13 closure through existing subsystems under a written P1 freeze →
weeks 5–7 audited merge, recorded 16-step demo, durability minimum,
start the 30-day §15 window → weeks 8+ the architecture backlog in
dependency order (perf lane → storage program → contracts →
decompositions).

---

## 1. Requirements coverage (PRD §6.1 / §6.2, 24 items)

Scoreboard: **11 implemented · 12 partial · 1 absent**. Fully done: auto/manual tracking, lexical+déjà-vu search (over-delivered as hybrid), all three packet types, inline review, bac_id invariant, redaction+injection-scrub+privacy-flag primitives (as stored-side implementations — see F01), coding-session attach, dispatch ledger, markdown projection, annotation capture, MCP read server.

**6.1.1 [P0] — Side-panel workboard — six views** → `partial`

packages/sidetrack-extension/entrypoints/sidepanel/App.tsx:780 (viewMode union 'now'|'workstream'|'all'|'inbox'|'connections'|'search'); App.tsx:7698 (RecentDispatches section); App.tsx:5646 (per-thread 'Queued follow-ups' list)

Current-tab card lives inside Inbox view (App.tsx:805-807); Needs-organize = inbox view + lifecycle pill (App.tsx:495); Search view + relative timestamps present. Missing: dedicated 'Queued (outbound)' view (queue only renders per-thread) and dedicated 'Inbound' view — InboundCard.tsx exists but is only mounted in entrypoints/preview/Preview.tsx (design preview); inbound reminders surface only as unread markers/lifecycle pills on thread rows (App.tsx:576-578).

**6.1.2a [P0] — Auto-track + manual track + stop/remove** → `implemented`

packages/sidetrack-extension/entrypoints/background.ts:895-906 (global settings.autoTrack gates auto vs manual mode); packages/sidetrack-companion/src/http/schemas.ts:148 (trackingMode enum 'auto'|'manual'|'stopped'|'removed'); App.tsx:5573 ('Stop tracking' action)

Auto/manual/stopped/removed all modeled and surfaced. Gap inside 6.1.2: per-site toggle is absent — only the global autoTrack boolean (background.ts:3601-3602 saveAutoTrack) plus the captureEnabled master kill-switch; no per-provider/per-site tracking toggle found.

**6.1.2b [P0] — Selector-canary fallback (clipboard mode + warn)** → `partial`

packages/sidetrack-extension/entrypoints/content.ts:1443-1480 (reportSelectorCanary, data-sidetrack-provider-canary attr, selectorCanary message); packages/sidetrack-extension/src/workboard.ts:66,164 (selectorCanary status on captures/workboard)

Canary detection + status provenance on every captured turn is implemented. The prescribed fallback behavior is not: no clipboard-capture mode exists anywhere under packages/sidetrack-extension/src/capture/ (zero clipboard hits), so a broken selector degrades without the PRD's clipboard-mode escape hatch.

**6.1.3 [P0] — Workstream tree + moves + inbox + tags + typed links** → `partial`

packages/sidetrack-companion/src/http/server.ts:6514-6790 (workstream CRUD incl. delete-with-child-guard at 6749-6781); packages/sidetrack-companion/src/workstreams/events.ts:29 (tags); schemas.ts:147,163 (tags on threads/workstreams); MoveToPicker.tsx (moves)

Nested tree (parent/child), moves preserving bac_id, Inbox as first-class view, and tags are all implemented. Typed user links (related/source_of/follow_up/coding_session_for/dispatched_to) are ABSENT — zero grep hits repo-wide; only DISPATCH_LINKED events (dispatches/events.ts:10) and the derived connections-graph edges exist, neither is the user-facing typed-link system.

**6.1.4 [P0] — QueueItem (outbound asks)** → `partial`

packages/sidetrack-companion/src/queue/events.ts:18 (QueueStatus = 'pending'|'done'|'dismissed'); queue/projection.ts; App.tsx:5646 (queued follow-ups UI); mcpServer.ts:502 (sidetrack.queue.create)

Queue items with thread/workstream/global scope, create/complete/dismiss, and panel rendering exist. Divergence: status lifecycle is pending/done/dismissed, not the PRD's pending→ready→sent/done/skipped; and 'compose packet from queue' (selected queue items becoming a Research Packet questions section) was not found in PacketComposer.tsx or contextPack.ts.

**6.1.5 [P0] — ReminderItem (inbound reminders)** → `partial`

packages/sidetrack-companion/src/http/server.ts:6857,6867 (POST /v1/reminders + PATCH /v1/reminders/:id → vaultWriter.createReminder); App.tsx:576-578 (unread derivation, status !== 'dismissed')

Detection→record→dismiss loop is implemented (extension watches turns, companion records ReminderItem, dismiss supported). Missing the PRD surface: no dedicated 'Inbound' view with 'Claude replied 3 minutes ago' rows — InboundCard.tsx is only used in the design-preview entrypoint, not the live panel; reminders manifest as lifecycle pills/unread dots on thread rows.

**6.1.6 [P0] — ChecklistItem (manual checklists)** → `partial`

packages/sidetrack-companion/src/workstreams/events.ts:31 (checklist on workstream); server.ts:6535 (checklist accepted on workstream PATCH); vault/markdownProjection.ts:105-112 (renders '## Checklist' - [x] list)

Full data path exists: events, projection, HTTP schema, extension client parse (src/companion/client.ts:183), markdown rendering. But there is NO side-panel UI to add/tick/remove checklist items — zero checklist hits in App.tsx or any live component (only test fixtures and a removed static list in PacketComposer). Also persists as a body checklist section, not the PRD's 'bac:checklist:' frontmatter array (still Obsidian-editable).

**6.1.7 [P0] — Tab recovery (TabSnapshot + chrome.sessions)** → `partial`

packages/sidetrack-extension/entrypoints/sidepanel/components/TabRecovery.tsx:4-6 (strategies focus_open/restore_session/reopen_url); App.tsx:545 (strategy derived: tabId undefined ? 'reopen_url' : 'focus_open')

TabSnapshot, 'closed (restorable)' lifecycle pill (App.tsx:5223), focus-open and reopen-URL strategies work. chrome.sessions/browser.sessions is never called anywhere in the extension (zero hits), so strategy 2 'Restore session' exists only as a UI enum branch that is never assigned — App.tsx:545 only ever produces focus_open or reopen_url.

**6.1.8 [P0] — Lexical search + recent déjà-vu** → `implemented`

packages/sidetrack-companion/src/recall/ranker.ts:237 (MiniSearch import; lexical side of hybrid); src/search/analyzer.ts (shared tokenizer for recall + page-content MiniSearch); server.ts:5537 /v1/recall/query; App.tsx search view; src/contentOverlays/dejaVuModel.ts (déjà-vu popover)

Exceeds P0: shipped as hybrid lexical+vector (/v2/recall at server.ts:5960) with RRF (search/rrf.ts), whereas PRD scoped MVP to lexical-only with vector at P1.

**6.1.9 [P0] — Packet generation (Context Pack / Research Packet / Coding Agent Packet)** → `implemented`

packages/sidetrack-extension/entrypoints/sidepanel/components/PacketComposer.tsx:111-131 (kinds context_pack/research_packet/coding_agent_packet/notebook_export), 133-171 (Research templates incl. deep_research), 804-812 (redaction summary); src/sidepanel/connections/contextPack.ts + ContextPackComposer.tsx; mcpServer.ts:365 (sidetrack.workstreams.context_pack)

All three packet types flow through redaction + token display + DispatchConfirm. Minor: composer-side token estimate is char/4 (PacketComposer.tsx:391) — the real tokenizer lives companion-side; §6.4 template coverage present via ResearchTemplate set.

**6.1.10 [P0] — Inline review (ReviewEvent + submit-back + dispatch-out)** → `implemented`

packages/sidetrack-extension/src/review/types.ts:4 (verdicts 'agree'|'disagree'|'partial'|'needs_source'|'open'); ReviewComposer.tsx:208 (dispatch to another AI); src/review/outbox.ts; packages/sidetrack-companion/src/vault/writer.ts:673,688 (_BAC/reviews/<date>.jsonl); vault/reviewDrafts.ts

Span-select composer, per-span comment+verdict, submit-back and dispatch-out both wired through the dispatch/safety chain. Storage divergence: ReviewEvents persist to _BAC/reviews/ JSONL, not as a 'bac_reviews:' frontmatter array on the captured-turn note.

**6.1.11 [P0] — Structured download / export naming convention** → `absent`

packages/sidetrack-companion/src/vault/writer.ts:757 (thread md = _BAC/threads/<bac_id>.md) and 847 (workstream md = _BAC/workstreams/<bac_id>.md)

All markdown lands in flat bac_id-named files under _BAC/. The PRD naming pattern <Project>/<Subproject>/.../<chat-name>-<reportN>.md (workstream-tree path projection, human-readable names, reportN counter) does not exist; no on-demand 'export as Markdown to tree path' route found in server.ts. bac_id-in-frontmatter half of the requirement IS met (markdownProjection.ts:83).

**6.1.12 [P0] — Stable IDs — bac_id 16-char ULID invariant** → `implemented`

packages/sidetrack-companion/src/domain/ids.ts:16 (createBacId = 16-char Crockford-base32 random); identity used everywhere (moves/renames keyed by bac_id, e.g. writer.ts upsertThread, markdownProjection.ts:83 frontmatter)

The invariant (identity survives rename/move/restructure; paths are projections) holds throughout. Pedantic divergence: ids are pure-random base32, not true ULIDs (no timestamp prefix, and byte%32 has slight modulo bias) — functionally equivalent for identity purposes.

**6.1.13a [P0] — RedactionPipeline** → `implemented`

packages/sidetrack-companion/src/safety/redaction.ts:13-40+ (rule table: anthropic-key, openai-key, github-token, bearer-token, email, ...); dispatches/events.ts:20-21 (only redacted body is ever persisted); PacketComposer.tsx:806 (redaction summary UI)

Runs before dispatch persistence and packet render. Rule list is a hardcoded const — the PRD's 'user-extendable' deny-list was not found.

**6.1.13b [P0] — Token-budget warnings** → `partial`

packages/sidetrack-companion/src/safety/tokenBudget.ts:5-15 (gpt-tokenizer cl100k encode, tokenBudgetWarningThreshold = 8000); packages/sidetrack-extension/src/safety/preflight.ts:25,73 (estimateTokensFast char/4 in auto-send preflight)

Real tokenizer + warning threshold exist and DispatchConfirm shows budget (PacketComposer.tsx:202). Divergence: fixed 8000-token threshold, not 'target model's context window' per-model budgets; extension preflight uses the char/4 heuristic.

**6.1.13c [P0] — Per-workstream privacy flag** → `implemented`

packages/sidetrack-companion/src/workstreams/events.ts:15 (WorkstreamPrivacy = 'private'|'shared'|'public'); http/schemas.ts:161; App.tsx:5076 (titleDisplay = isPrivate ? '[private]' : title); src/workboard.ts:417 (mask predicate); src/settings/types.ts (screenShareSafeMode)

Flag + [private] masking + manual screenShareSafeMode toggle all live. Did not verify that new workstreams default to 'private' as the PRD requires.

**6.1.13d [P0] — Captured-page injection scrub** → `implemented`

packages/sidetrack-extension/src/safety/injectionScrub.ts:1-30 (<context>...</context> wrapping, pattern set, pure module); src/safety/preflight.ts:19 (scanForInjection runs unconditionally in the §24.10 preflight)

Wrap-not-refuse strategy exactly per PRD; wired into both side-panel dispatch and auto-send drain paths.

**6.1.14 [P0] — MCP write tools (move_item/new_cluster/queue_item/link_items/attach_coding_session) + per-workstream trust + audit** → `partial`

packages/sidetrack-companion/src/auth/workstreamTrust.ts:4-11 (trust store, allowed tools = threads.move, queue.create, workstreams.bump, threads.archive, threads.unarchive); http/server.ts:1339-1343 (server-side isAllowed gate → 403); server.ts:6623,6650 (trust GET/PUT); mcpServer.ts:469,502 + sessionTools.ts:29 (sidetrack.threads.move, sidetrack.queue.create, sidetrack.session.attach)

3 of 5 PRD tools shipped (move_item→threads.move, queue_item→queue.create, attach_coding_session→session.attach) plus bump/archive extras; new_cluster and link_items are ABSENT (no workstream-create or link tool in mcpServer.ts). Trust is per-workstream and enforced companion-side with TrustToggles.tsx UI; untrusted calls hard-fail rather than falling back to the PRD's per-call approval modal. Audit exists (_BAC/audit/<date>.jsonl, writer.ts:429) but auditEventSchema (schemas.ts:355-361) records only requestId/route/outcome/bac_id/timestamp — no agent ID, tool name, args, or trust-mode-active fields.

**6.2.1 [P0.5] — Coding session attachment + resume** → `implemented`

packages/sidetrack-companion/src/http/schemas.ts:227-232 (tool/cwd/branch/sessionId/resumeCommand); src/coding/events.ts; packages/sidetrack-extension/entrypoints/sidepanel/components/CodingAttach.tsx:171,229,436-446 (resume prompt → clipboard); mcpServer.ts sessionTools.ts:29 (sidetrack.session.attach); tests/e2e/coding-attach.spec.ts

Manual attach with all PRD fields, sessions in the workstream tree, resume via copy-to-clipboard (the PRD-sanctioned fallback), linkable to dispatches via mcpRequest.codingSessionId (dispatches/events.ts:27).

**6.2.2 [P0.5] — Async dispatch ledger (DispatchEvent)** → `implemented`

packages/sidetrack-companion/src/dispatches/events.ts:9-33 (DISPATCH_RECORDED/DISPATCH_LINKED, target.provider, sourceThreadId, redacted body); http/schemas.ts:19 (status enum queued/sent/replied/noted/pending/failed); packages/sidetrack-extension/src/background/state.ts:1116-1133 (auto-flip to 'replied' on fresh assistant turn); App.tsx:7698 (RecentDispatches view)

Ledger persists to _BAC/dispatches/<date>.jsonl (writer.ts:537) + dispatch-links (writer.ts:577); replied-detection pairs with reminders as PRD specifies.

**6.2.3 [P0.5] — Auto-download on promote** → `partial`

packages/sidetrack-companion/src/vault/writer.ts:793-816 (promotedForFirstTime → renderPromotedThreadMarkdown with recent turns written at promote time)

Promote-time vault write fires automatically. Missing the PRD's control surface: no per-workstream toggle, no tier defaults (off-for-Inbox / on-for-project), no override setting (zero autoDownload/autoExport hits repo-wide); and output goes to _BAC/threads/<bac_id>.md, not the §6.1.11 structured naming path.

**6.2.4 [P0.5] — Markdown / Obsidian projection** → `implemented`

packages/sidetrack-companion/src/vault/markdownProjection.ts (frontmatter incl. bac_id at :83, wikilinked children, checklist section); writer.ts:800-822,847-942 (projection rewritten on every thread/workstream mutation, markdown-lock sentinel respected); vault/linkback.ts

Projects on every change via companion (per §27); plain-file writes, no Obsidian plugin required. Did not find the optional Local-REST-API surgical PATCH path; files are flat under _BAC/ rather than a human tree (covered under 6.1.11).

**6.2.5 [P0.5] — Annotation capture (lightweight)** → `implemented`

packages/sidetrack-companion/src/annotations/events.ts:4-12,30 (annotation.created: anchor + url + note; noteSet register); vault/annotationStore.ts; packages/sidetrack-extension/entrypoints/content.ts:3-4,437-478 (findAnchor/serializeAnchor + in-page annotation set); sidepanel/components/AnnotationOverlay.tsx; mcpServer.ts:645-685 (annotations list/update/delete)

Exceeds P0.5: persistent in-page anchoring (the piece PRD deferred to P1) is already live, plus MCP batch-create (annotationTools.ts:93).

**6.2.6 [P0.5] — MCP read server (stdio + local transport)** → `implemented`

packages/sidetrack-mcp/src/server/mcpServer.ts:325-1082 (30 registered tools: threads.list, workstreams.get/context_pack, search, queue.list, reminders.list, sessions.list, audit.list, dispatches.list, reviews.list, recall.query, system.health, buckets.list, annotations.*, connections.*); cli.ts:5,26 (stdio + streamable-http transports); streamableHttpServer.ts:13-15 (port 8721, /mcp, auth-required code)

Tool surface exceeds the PRD list. Divergences: namespace is sidetrack.* not bac.*; long-lived local transport is MCP streamable-HTTP on 8721 rather than raw WebSocket; read-path audit logging of MCP tool calls happens only via companion HTTP routes, not for direct LiveVaultReader reads.


### Investment drift

Engineering investment is heavily concentrated in PRD P1 territory while a cluster of P0/P0.5 items sits partial or absent. Scale: connections graph = 29,246 LOC (packages/sidetrack-companion/src/connections — IVM materializer, leiden-cpm topic producer, similarity/attribution, SQLite edge store), learned ranker = 14,894 LOC (src/ranker — impression loop, trainable-action emission, online head, retrain), recall+recall-v2 = 18,821 LOC (hybrid vector recall, sqlite-vec store, embedder child processes). Combined ~63k LOC vs ~1.4k LOC for the entire P0 core of queue+review+dispatches+safety+workstreams. Of the 62 commits ahead of origin/main visible locally, 43 (69%) are ranker/recall/connections/health/attribution work (e.g. 08b4e72f trainable recall.action events, 14b8f862 retrain fix, 2f76ab63 workGraph health, 60369f18 aggregator false-friends) — all §6.3.1 smart recall / §6.3.6 suggestion-layer territory that the PRD explicitly scopes post-MVP ('MVP ships lexical only; vector is a follow-up', §6.1.8). Meanwhile the P0/P0.5 gaps are mostly small-to-medium UI/plumbing work: no checklist add/tick UI (data path complete, App.tsx renders nothing), no typed user links (related/source_of/follow_up/... — zero hits), no MCP new_cluster/link_items tools, structured export naming absent (everything flat under _BAC/<type>/<bac_id>.md instead of the workstream-tree path convention), chrome.sessions restore never wired (strategy enum exists, API never called), no dedicated Queued/Inbound workboard views (InboundCard only in design preview), no per-site auto-track toggle, no clipboard fallback behind the selector canary, queue statuses truncated (pending/done/dismissed vs pending→ready→sent/done/skipped), no compose-packet-from-queue, no per-workstream auto-download toggle, and the audit schema lacks the agent-ID/tool/args/trust-mode fields §6.1.14 requires. Two places over-deliver relative to spec (hybrid vector search shipped at P0-time; persistent annotation anchoring shipped at P0.5-time), which is the same drift seen from the other side. Net: the safety chain, dispatch ledger, review primitive, packets, MCP surface, and privacy flag are genuinely done — but §13 acceptance steps 3 (six views), 7 (checklist), 8 (session restore), 13 (structured export path) and §15 criteria around export/recovery cannot pass today, and closing them is mostly days-scale work compared to the multi-week P1 systems that absorbed the branch.

---

## 2. Confirmed findings (35/35 survived adversarial verification)

### F01 — Safety chain (redaction + injection scrub + preflight gates) runs only on stored/auto-send lanes; every user-facing outbound dispatch path ships raw text

- **Severity**: high · **Effort**: M · **Area**: safety chain / PRD 6.1.13 (ship-blocking) · **Found by**: security, product-gap
- **Files**: packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/safety/redaction.ts, packages/sidetrack-extension/entrypoints/sidepanel/App.tsx, packages/sidetrack-extension/src/messages.ts, packages/sidetrack-extension/entrypoints/background.ts, packages/sidetrack-extension/src/safety/preflight.ts
- **Evidence**: redact() has exactly one call site — server.ts:4535 — applied to the STORED dispatch body. App.tsx:4126 copies pendingDispatch.body (pre-redaction) to clipboard; comment at App.tsx:4099-4102 states 'the companion stored a redacted form, but the user pastes the original'; messages.ts:73-78 cacheDispatchOriginal deliberately retains the unredacted body. scanForInjection's only caller is evaluateAutoSendPreflight (preflight.ts:19,72), whose only caller is autoSendDrain.ts:151; the dispatchAutoSendInNewTab handler (background.ts:3411-3425 → autoSendOnceTabReady:1847-1866) auto-types body verbatim into a provider tab with zero gates — no scrub, no screenShareSafeMode, no token check — fed the unredacted dispatchOriginals body from App.tsx:7786-7797. Manual copy paths (App.tsx:4047, 4055, 4126) ship raw packet.body. Redaction rules are a hardcoded const missing AWS-key/SSN/phone categories (redaction.ts:13-45).
- **Why it matters**: PRD 6.1.13 requires redaction and the captured-page injection scrub BEFORE any outbound dispatch, including manual copy, and marks this ship-blocking ('one cross-pollination away from leaking API keys'). Today secrets/emails/keys reach ChatGPT/Claude/Gemini intact — only the local audit copy is sanitized, the inverse of the requirement — and the fully-automated redispatch path lets a poisoned captured page reach the model with no wrap and no human gate.
- **Direction**: Have POST /v1/dispatches return the redacted body and make clipboard/auto-send/redispatch/selection paths all route through one preflight entry point enforcing redaction + injection scrub + screen-share gate; reconcile the auto-link matcher against the redacted text; add missing rule categories.
- **Verifier notes**: Confirmed all citations: redact() sole call server.ts:4535 (stored copy only); raw-body clipboard App.tsx:4047/4055/4126; unredacted cache messages.ts:73-78, App.tsx:7786; ungated auto-type background.ts:3411→1847 (plus selection 3489, MCP 2380); scanForInjection only via preflight.ts:72→autoSendDrain.ts:151; redaction.ts:13-50 lacks AWS/SSN/phone vs PRD.md:385-388 ship-blocking. | Confirmed: redact() sole call server.ts:4535 (stored body only); App.tsx:4047/4055/4126 copy raw body; messages.ts:73-78 caches unredacted original; background.ts:3411/3432→autoSendOnceTabReady:1847 auto-type raw with zero gates (App.tsx:7786 prefers dispatchOriginals); scanForInjection gated lane = autoSendDrain.ts:151 only; redaction.ts:13-50 lacks AWS/SSN/phone. PRD.md:379-388 P0 ship-blocking, includes manual copy.

### F02 — MCP write-tool trust is self-reported via header and allow-by-default; audit ledger cannot attribute or even detect agent writes

- **Severity**: high · **Effort**: M · **Area**: MCP trust + audit (PRD 6.1.14) · **Found by**: security, product-gap
- **Files**: packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/auth/workstreamTrust.ts, packages/sidetrack-companion/src/http/schemas.ts
- **Evidence**: Trust gate fires only when the caller volunteers the x-sidetrack-mcp-tool header (server.ts:6361-6364, 6441, 6488, 6678, 6813); omit it and the same route performs the write ungated. isAllowed returns true when no trust record exists (workstreamTrust.ts:77) — comment at :65-70 documents this as a deliberate flip vs PRD 6.1.14 'opt-in only — no default', but the deviation is unrecorded. auditEventSchema is requestId/route/outcome/bac_id/timestamp only (schemas.ts:355-361) — no agent, tool, args, scope, or trust-mode fields, so MCP writes are indistinguishable from extension writes and the header-drop bypass is invisible.
- **Why it matters**: PRD 6.1.14 makes per-workstream trust and a complete audit trail P0. Any bridge-key-holding agent bypasses trust by dropping one header, and the ledger cannot detect it — the trust model's accountability premise is void.
- **Direction**: Derive caller identity server-side (per-client or MCP-scoped keys) and enforce trust on identity, not a voluntary header; add agent/tool/args/trustMode to auditEventSchema; record the allow-by-default deviation in the PRD decisions log or add a first-run opt-in.
- **Verifier notes**: All cited lines verified current: header-gated trust (server.ts:1349-1363,6361-64,6440-46,6487-93,6677-79,6811-14), allow-by-default (workstreamTrust.ts:77, comment 65-70) vs PRD.md:432, 5-field audit (schemas.ts:355-361, writer.ts:427-432) vs PRD.md:426-429. Shared bridge key (server.ts:7834) makes identity underivable. Minor: per-client keys exceed PRD (PRD.md:433 mandates same key). | Confirmed: trust gated solely on voluntary header (server.ts:1349-1363, 6361-6364, 6440, 6487, 6677, 6811); isAllowed defaults allow (workstreamTrust.ts:77) contradicting PRD.md:432 "opt-in only — no default" (P0 §6.1.14); auditEventSchema (schemas.ts:355-361) lacks PRD.md:426-429 agent/tool/args/scope/trust-mode fields. Mitigations: localhost, key-gated, route-level audit exists.

### F03 — MCP streamable-http transport serves the whole vault with no auth by default and no DNS-rebinding defense

- **Severity**: medium · **Effort**: S · **Area**: loopback auth / DNS rebinding · **Found by**: security
- **Files**: packages/sidetrack-mcp/src/server/streamableHttpServer.ts, packages/sidetrack-mcp/src/cli.ts
- **Evidence**: isAuthorized returns true whenever authKey is undefined/empty (streamableHttpServer.ts:94-97); cli.ts:666 sets authKey only from --mcp-auth-key/--bridge-key, and cli.ts:649-660 permits starting the http transport with neither. Origin gate runs only when an Origin header is present (streamableHttpServer.ts:150-158) and there is NO Host-header check (the companion has one, server.ts:812, 7819). Key compare at :103 is not timing-safe.
- **Why it matters**: A DNS-rebound page (same-origin after rebind sends no Origin) or any local process can read all threads, turns, and connections on :8721 when the transport runs keyless — a silent full-vault privacy failure in a privacy-first product.
- **Direction**: Refuse to start the http transport without an auth key; add a Host-header loopback check; use timingSafeEqual.
- **Verifier notes**: All evidence confirmed: keyless-allow streamableHttpServer.ts:94-97, keyless start cli.ts:665-670, no Host check (companion has http/server.ts:812,7819), non-timing-safe :103. But http transport is opt-in (stdio default cli.ts:64), loopback-bound :128, and MCP POSTs carry Origin in modern browsers so rebinding is mostly blocked; real keyless leak is any chrome-extension origin (:79-85). | Confirmed: keyless-open isAuthorized (streamableHttpServer.ts:94-97), optional key (mcp cli.ts:665-675), Origin-only gate/no Host check (:150-158 vs companion server.ts:812,7819), non-timing-safe ===(:103). Rebind viable via no-referrer POST. But companion spawn auto-generates key (companion cli.ts:888-895,1068-1081), so default deployment is keyed; keyless needs manual standalone launch. Read-only exposure.

### F04 — New workstreams default to privacy 'shared'/unset, contradicting the PRD-mandated 'private' default that is the designated v1 privacy control

- **Severity**: high · **Effort**: S · **Area**: privacy defaults (PRD 6.1.13) · **Found by**: security, product-gap
- **Files**: packages/sidetrack-companion/src/vault/writer.ts, packages/sidetrack-companion/src/workstreams/projection.ts, PRD.md
- **Evidence**: createWorkstream sets `privacy: input.privacy ?? 'shared'` (writer.ts:839); projection.ts:45 sets privacy only when the payload provides it — no 'private' default anywhere. PRD.md:396 states 'Default for new workstreams: `private`' and PRD.md:1041-1045 designates the private flag as the P0 privacy substitute users 'rely on' for deferred screen-share auto-detect.
- **Why it matters**: The privacy flag is the PRD's substantive v1 privacy control; defaulting open means every workstream created without an explicit choice is unmasked during screen shares — a silent divergence on a ship-blocker item, and the masking mechanism protects nothing until users act.
- **Direction**: Flip the creation default to 'private' (writer.ts:839, projection.ts:45, plus any extension-side create paths); one-line change plus test updates.
- **Verifier notes**: Confirmed: writer.ts:839 `privacy: input.privacy ?? 'shared'`; projection.ts:45 no default. PRD.md:396 mandates 'private'; PRD.md:1041-1045 designates it the P0 control. Masking fail-open (App.tsx:528). Understated: extension hardcodes privacy:'shared' on create (App.tsx:3228,3415,7196,7233), so fix needs extension too. | Confirmed: writer.ts:839 and extension state.ts:1279/894 default 'shared'; all four App.tsx create sites (3225/3414/7192/7229) hardcode 'shared' with no user choice; masking requires ==='private' (workboard.ts:417). PRD.md:396 mandates 'private' default; Q6 deferral (PRD:1040-1046) rests on correct defaults. Unfixed on branch.

### F05 — PRD §13 acceptance scenario breaks at steps 7, 9, 11, and 13 — P0 features have complete backends but zero UI or route

- **Severity**: high · **Effort**: M · **Area**: P0 completeness / MVP ship gate · **Found by**: product-gap
- **Files**: packages/sidetrack-extension/entrypoints/sidepanel/App.tsx, packages/sidetrack-companion/src/vault/markdownProjection.ts, packages/sidetrack-companion/src/vault/writer.ts, packages/sidetrack-extension/entrypoints/sidepanel/components/InboundCard.tsx, packages/sidetrack-extension/entrypoints/sidepanel/components/PacketComposer.tsx, packages/sidetrack-companion/src/queue/events.ts
- **Evidence**: Step 7: rg -a finds zero 'checklist' hits in App.tsx though the full data path exists (markdownProjection.ts:106-112 renders it; client.ts:183 parses it). Step 9: viewMode union App.tsx:779-781 has no 'inbound'/'queued'; InboundCard is mounted only in entrypoints/preview/Preview.tsx. Step 11: PacketComposer's only queue reference is a mock meta string (:197) — no queue-item selection feeds the Research Packet, though MCP context_pack already includes queue items (mcpServer.ts:364-375); QueueStatus is 'pending'|'done'|'dismissed' (queue/events.ts:18) vs PRD §6.1.4 pending→ready→sent/done/skipped. Step 13: markdown lands flat at _BAC/threads/<bac_id>.md (writer.ts:757) / _BAC/workstreams/<bac_id>.md (writer.ts:845-848); no export route exists in server.ts.
- **Why it matters**: PRD §13 says 'If all 16 steps work, MVP ships.' The scenario first hard-fails at step 7 today, so MVP cannot be declared done regardless of P1 progress; the queue-to-packet handoff — the napkin's core loop — doesn't exist in the UI.
- **Direction**: Days-scale closure sprint: checklist add/tick UI, dedicated Inbound + Queued views (mount existing InboundCard), queue-item selection in PacketComposer (companion data already flows), one export-to-tree-path route; record the simplified 3-state queue lifecycle as a PRD amendment unless sent/skipped semantics are wanted.
- **Verifier notes**: Confirmed all four: App.tsx has 0 'checklist' (byte-scan) vs backend markdownProjection.ts:105-112/client.ts:183; viewMode App.tsx:779-781 lacks inbound/queued, InboundCard only in Preview.tsx:174 stub harness; live PacketComposer scope (App.tsx:7989-8024) passes no queue items, QueueStatus 3-state (queue/events.ts:18); writer.ts:757/846 flat paths, http/server.ts has only /v1/settings/export. Bonus: handlePacketSave toast falsely claims vault save. Minor: unread-reply bucket partially covers step 9. | Confirmed all 4 breaks: no checklist UI (rg -a App.tsx=0; backend at schemas.ts:165, writer.ts:837); viewMode App.tsx:779-781 lacks inbound (InboundCard only in Preview.tsx:174 stubs); PacketComposer.tsx:197 mock queue meta, scope App.tsx:7994-8014 passes no queue items; export=flat download App.tsx:4030-4033, no route (server.ts 109 patterns). PRD.md:1131 gates MVP. Minor: reminders show as unread bucket App.tsx:578.

### F06 — Investment drift: ~40k LOC in explicitly post-MVP P1 systems vs ~800 LOC in the P0 core the acceptance scenario needs

- **Severity**: high · **Effort**: S · **Area**: roadmap alignment · **Found by**: product-gap
- **Files**: packages/sidetrack-companion/src/connections, packages/sidetrack-companion/src/ranker, packages/sidetrack-companion/src/recall-v2, PRD.md
- **Evidence**: Measured non-test LOC: connections 18,348 + ranker 8,990 + recall 6,847 + recall-v2 6,032 = 40,217; queue+dispatches+safety+workstreams+auth = 787. Unmerged commits ahead of origin/main are dominated by ranker(13)/recall(5)/materializer(5)/connections(3)/health(3) scopes. PRD §6.1.8: 'MVP ships lexical only; vector is a follow-up'; §6.3.1/6.3.6 scope this work post-MVP.
- **Why it matters**: The branch compounds P1 capability while §13 cannot pass and §15 export/recovery criteria fail — MVP viability is gated on days-scale P0 work that keeps losing to multi-week P1 systems.
- **Direction**: Explicit sequencing decision: freeze new P1 scope until the §13 blockers close, or formally re-scope the PRD to match the recall-first strategy.
- **Verifier notes**: LOC verified: connections 18348/ranker 8990/recall 6847/recall-v2 6032=40217; queue+dispatches+safety+workstreams+auth=787 exact. PRD.md:317 "MVP ships lexical only" verbatim; §6.3.1/6.3.6 P1 (PRD.md:523-579). 62 unmerged commits: ranker 14/recall 7/materializer 5/health 5/connections 3 — dominated. Caveat: "P0 core" excludes sync/http/collectors, slightly rhetorical. | Confirmed: 40,217 LOC in PRD-designated P1 systems (PRD.md:316-317, §6.3.1/§6.3.6); 62 unmerged commits dominated by ranker(13)/recall(6)/materializer(5). But 787-LOC denominator cherry-picks 5 dirs — P0 spans vault(2307)+tabsession(2154)+timeline(959)+search(585)+safety/portability, and §13 machinery exists (PacketComposer.tsx, tokenBudget.ts, exportBundle.ts). Drift real; "MVP-gated" overstated.

### F07 — Cross-package contracts unenforced: OpenAPI covers 13 of 108 routes, MCP docs describe a dead namespace, API shapes hand-triplicated, vault file format unpinned by any round-trip test

- **Severity**: high · **Effort**: L · **Area**: boundary contracts · **Found by**: modularity, testing
- **Files**: packages/sidetrack-companion/openapi.yaml, packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/http/schemas.ts, packages/sidetrack-extension/src/companion/client.ts, packages/sidetrack-extension/src/messages.ts, packages/sidetrack-mcp/src/cli.ts, packages/sidetrack-mcp/src/vault/liveVaultReader.test.ts, docs/mcp/README.md, docs/extension-messages/, AGENTS.md
- **Evidence**: openapi.yaml declares 13 paths vs 108 route patterns in server.ts:2539+ (no recall, /v2/recall, connections, annotations, audit, trust, coding-sessions, ranker); last touched c4daca25 (2026-05-23, pre-/v2); lint:openapi not in the verify chain. docs/mcp/*.md documents 17 `bac.*` tools; mcpServer.ts registers 30 `sidetrack.*` tools (mcpServer.ts:326+). docs/extension-messages has 1 contract vs 74 messageTypes (messages.ts:29). Zero cross-package imports: extension re-implements shapes as hand-rolled parsers with `as` casts (client.ts:64-163, 72, 208; messages.ts:542 'mirrors the shape of packages/sidetrack-companion/src/recall-v2/types.ts'); MCP re-parses envelopes ad hoc (cli.ts:182, 202, 571). MCP vault-reader tests hand-author fixtures (liveVaultReader.test.ts:26-86); no round-trip test writes with the companion writer and reads with LiveVaultReader.
- **Why it matters**: AGENTS.md:60 and CODING_STANDARDS.md:91 mandate a boundary contract per feature; ~90% of the live API surface is uncontracted and existing docs are actively wrong. Three hand-maintained copies of every response shape drift silently (urlSlashVariants-class bugs already bitten), and the companion-writer→MCP-reader file format agrees only by convention.
- **Direction**: Publish a shared zod schema package (or generate OpenAPI from schemas.ts and clients from it); regenerate MCP tool docs from capabilities; add wire-shape contract tests plus one companion-writer→LiveVaultReader round-trip test; wire a coverage check into scripts/verify-standards.sh.
- **Verifier notes**: Confirmed: openapi.yaml=13 paths vs 108 route patterns (server.ts:2539+), last touch c4daca25; lint:openapi absent from verify (package.json:29). docs/mcp=17 bac.*.md vs 30 sidetrack.* registerTool (mcpServer.ts:325+, zero bac.* remain). client.ts:59-90/cli.ts:182-207 as-casts. liveVaultReader.test.ts:20-90 hand fixtures; only writer round-trip e2e is test.skip'd. messageTypes=69 not 74. | Confirmed: openapi.yaml 13 paths vs 108 route patterns (server.ts); verify-standards.sh omits lint:openapi; docs/mcp 17 bac.* files, 0 bac.* in MCP src (registers sidetrack.*); codexHandoff.test.ts:9 fake companion, no round-trip. PRD.md:508,1124 mandate bac.* (acceptance step 15 breaks verbatim). But read-side only, no data-safety threat; tools/list self-describes — medium.

### F08 — server.ts monolith violates thin-delivery, no-hidden-global-state, and ports-and-adapters: 108 inline handlers, 8 module-scope caches, 12 instanceof-store branches, 47-field god-config

- **Severity**: high · **Effort**: L · **Area**: companion HTTP architecture · **Found by**: modularity
- **Files**: packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/runtime/companion.ts, packages/sidetrack-companion/src/connections/snapshot.ts, CODING_STANDARDS.md
- **Evidence**: 8021 LOC; 108 handlers inline in one flat routes array (server.ts:2539), linear regex scan per request (7798-7802). Eight module-scope mutable caches shared across all server instances (lexicalIndexCache:929, systemHealthCache:1405, connectionsResponseCache:1459, threadSuggestionsCache:1640, routeCache:1691, hygieneCache:1726, url/tabSession projection caches:2329-2330); string-prefix invalidation (invalidateResolveCaches:1807). Domain policy inline in the /v2/recall handler (5956-6055). 12 `instanceof SqliteConnectionsStore` checks inside route/projection code (1531, 2481, 2507, 2792, 3154, 3231, 3488, 3653, 3818, 6215, 7622, 7690) branch on a concrete infrastructure class. CompanionHttpConfig (395-571) carries ~47 optional closure fields; omitted fields return 503 at runtime. Two validation regimes: zod vs unchecked objectRecord cast (2146-2149, 14 call sites).
- **Why it matters**: Breaks CODING_STANDARDS non-negotiables 2 and 5 plus the ports-and-adapters rule. This file is the recurring locus of production incidents (resolve floods, 45s timeouts, cache-bust regressions); test servers wire a materially different config than production; store-backend swaps require editing 12 route sites.
- **Direction**: Extract per-resource route modules registered into the dispatcher; move caches into an injected per-vault cache registry; add capability methods to the ConnectionsStore port replacing instanceof; split CompanionHttpConfig into required per-feature port groups; migrate objectRecord handlers to zod.
- **Verifier notes**: Every claim verified at cited lines: 8021 LOC; 108 inline handle closures in flat routes array (server.ts:2539, linear regex find 7798-7802); all 8 module caches (929/1405/1459/1640/1691/1726/2329-30); 12 instanceof at exact lines; 47 optional config fields (395-571) with documented 503s; objectRecord 14 sites vs zod. CODING_STANDARDS.md:10,13,33 confirm violated rules. | All claims verified at cited lines: 8021 LOC, routes:2539, linear scan:7798-7802, 8 module caches (929/1405/1459/1640/1691/1726/2329-30), 12 instanceof, exactly 47 optional config fields, 503-on-omission (443/494/529). Documented incidents (45s timeouts, resolve-flood via instanceof fork at 1531) threaten PRD §15 7-day-continuity criterion; data safety unaffected.

### F09 — Append-only event data grows unbounded; 93% of daily bytes is engagement telemetry; nothing compacts it

- **Severity**: high · **Effort**: L · **Area**: storage growth · **Found by**: performance
- **Files**: packages/sidetrack-companion/src/gc/plan.ts, packages/sidetrack-companion/src/sync/eventLog.ts, packages/sidetrack-companion/src/sync/eventStore.ts, packages/sidetrack-companion/src/vault/writer.ts
- **Evidence**: Live vault: _BAC/log 476MB / 637,832 events, ~9-10MB/day; the 2026-07-11 shard is 93% engagement.interval.observed (3.28MB of 3.5MB). event-store.db mirrors it at 601MB; legacy _BAC/events 70MB. gc/plan.ts:4-12 GcGroup covers only derived artifacts (revisions/diagnostics/dumps/idempotency); auditRetention.ts rotates only audit. No compaction path exists for log, store, or events dir.
- **Why it matters**: Every full-history read, drain catch-up, memo, and rebuild cost scales with lifetime event count; a years-of-usage vault multiplies every past CPU/latency incident and local-first disk cost.
- **Direction**: Telemetry rollup lane: fold engagement intervals into engagement-facts.db then tombstone/archive raw events; watermark-prune event-store; log compaction with a rebuild-from-truth guarantee.
- **Verifier notes**: Confirmed. gc/plan.ts:4-11 covers derived artifacts only; auditRetention.ts:24 only _BAC/audit; eventLog.ts:763-766 admits compacting shards unsupported, "no such writer in-tree"; eventStore.ts:371 DELETE only in rebuildFromJsonl. Live: log 476MB/637,481 events; today's shard 93.5% count / 89.9% bytes engagement.interval.observed; event-store.db 585MB. | Confirmed live: log 476MB/637,832 events, event-store.db 601MB; today's shard ~90% engagement bytes. gc/plan.ts:4-12 covers only derived artifacts; eventLog.ts:763-766 admits no compaction writer exists; eventStore.ts DELETE only on rebuild. Downgraded to medium: hot paths now indexed; residual is boot/rebuild/memory-floor scaling, not v1-window breach.

### F10 — Whole-log JS-heap materialization is the DEFAULT read architecture; the typed SQLite path is env-gated off

- **Severity**: high · **Effort**: L · **Area**: storage read path / memory ceiling · **Found by**: performance
- **Files**: packages/sidetrack-companion/src/sync/eventStore.ts, packages/sidetrack-companion/src/sync/eventLog.ts, packages/sidetrack-companion/src/http/server.ts
- **Evidence**: eventStore.ts:61 eventStoreEnabled requires SIDETRACK_EVENT_STORE=1 (default OFF, rationale dated 2026-05-29 — before the typed-read sweep). server.ts:2262-2263: store null → readMerged().filter for all ~18 typed routes; the materializer is likewise gated (connectionsMaterializer.ts:2452). eventLog.ts:528-541 memo holds every AcceptedEvent ('hundreds of MB'). Live rig (env ON, bun --smol): RSS 2.25GB.
- **Why it matters**: Default installs run the exact architecture behind the 45s /status and resolve-flood incidents; main-process memory grows linearly with vault age on consumer machines — MVP viability at multi-year scale.
- **Direction**: Build SQL aggregation projections (eventStore.ts:56-59's own recommendation), re-benchmark, then default the store ON; retire readMerged as serving fallback.
- **Verifier notes**: Confirmed: eventStore.ts:61 default-OFF gate (only run-test-companion.sh:52 sets it); server.ts:2262-2263 readMerged().filter fallback for 18 call sites; connectionsMaterializer.ts:2452 gate; eventLog.ts:528-541 full-log memo ("hundreds of MB", 60s idle TTL). Nuance: eventStore.ts:45-60 measured store-ON gives no heap win; 45s-/status was store-path untyped scans. | Mechanics confirmed: eventStore.ts:61/497 default-OFF, server.ts:2263 readMerged fallback, connectionsMaterializer.ts:2452 gate. But eventStore.ts:45-60 shows store-ON measured net-negative (RSS 1064 vs 853MB, ~100% CPU); memo TTL-evicts (eventLog.ts:540-564); cited incidents fixed and misattributed; PRD sections 13/15 have no memory criterion. Downgrade to medium.

### F11 — Replica seq counter never reconciled against shard tails — dot reuse can permanently poison the causal log

- **Severity**: high · **Effort**: S · **Area**: event-log crash recovery · **Found by**: integrity
- **Files**: packages/sidetrack-companion/src/sync/replicaId.ts, packages/sidetrack-companion/src/sync/eventLog.ts, packages/sidetrack-companion/src/vault/atomic.ts
- **Evidence**: replicaId.ts:49-60 parses an empty/garbled replica-seq file to 0; loadOrCreateReplica (103-132) trusts only that file. readShardTailSeq exists (eventLog.ts:441-450) but is used only by readMergedSince (:629), never at boot. appendClient (:887-906) dedupes on clientEventId only — a reissued dot appends unchecked. atomic.ts:6-17 rename has no fsync, so power loss or backup-restore can regress the counter.
- **Why it matters**: A regressed counter mints duplicate (replicaId,seq) dots: peers raise DotCollisionError and quarantine the replica; local causal ordering corrupts silently. Repair is manual. Directly threatens PRD §15 7-day zero-data-loss.
- **Direction**: At boot, set highWaterMark = max(seq file, max readShardTailSeq over own shards); optionally guard appendClient with idx.dotKeys.
- **Verifier notes**: Confirmed: readSeqFile→0 on garble (replicaId.ts:49-60); no boot reconciliation (observeSeq :136 has zero prod callers; readShardTailSeq only at eventLog.ts:629); appendClient dedupes clientEventId only (:892), mints seq blind (:910) despite idx.dotKeys existing (:1017); atomic.ts:6-17 no fsync; DotCollisionError real (:1025). "Quarantine" slightly paraphrased. | Confirmed: replicaId.ts:49-60,99-109 trust seq file only; observeSeq (136-143) unwired in production; readShardTailSeq used only at eventLog.ts:629; appendClient:892-913 skips dotKeys; atomic.ts:6-17 no fsync. But persist-before-return (replicaId.ts:126-132) survives ordinary crashes, so PRD-15's crash criterion holds; only power-loss/backup-restore triggers. Downgraded high to medium.

### F12 — Extension capture outbox loses explicit captures: non-atomic clear-then-re-enqueue eviction, whole-queue rewrite races, no single-flight drain

- **Severity**: high · **Effort**: M · **Area**: extension offline capture path · **Found by**: reliability, integrity
- **Files**: packages/sidetrack-extension/src/companion/queue.ts, packages/sidetrack-extension/src/companion/outbox.ts, packages/sidetrack-extension/entrypoints/background.ts
- **Evidence**: queue.ts:178-184: when the 1000-item outbox is full and an explicit capture arrives, the code does `captureOutbox.clear(storage)` then re-enqueues survivors one awaited write at a time — MV3 SW termination between clear and re-adds drops up to 999 queued captures. drain reads the queue once (outbox.ts:235), awaits network sends, then rewrites the whole key (:290-292); an enqueueCapture completing during those awaits is overwritten and lost. replayQueuedCaptures runs on every withCompanionStatus cycle (background.ts:2493) with no mutex, so concurrent drains are routine.
- **Why it matters**: Explicit captures are the PRD's protected no-silent-drop class; both races drop them silently in exactly the offline conditions the queue exists for (PRD §9, PRD.md:942-944, Story 17). Idempotency keys make re-sends safe but cannot resurrect overwritten items.
- **Direction**: Serialize all queue mutations through one promise-chain mutex in the SW; replace end-of-drain whole-queue rewrite with per-item remove-by-id merges; make eviction a two-key write-then-swap (or add a drop-at-index primitive).
- **Verifier notes**: Verified all cites: queue.ts:178-184 clear-then-re-enqueue (also resets ids/attempts, outbox.ts:211-214); outbox.ts:235/290-292 stale whole-key rewrite with changed=true even on all-fail drains (:258) — loses enqueues made during offline/busy drains; background.ts:2493 unguarded per-cycle drain, no mutex (pattern exists elsewhere :1733,:2282). PRD §9 + queue.ts:17-25 no-silent-drop violated. | Confirmed all three: clear-then-re-enqueue eviction queue.ts:178-184 (clear at outbox.ts:190-192); stale whole-key rewrite outbox.ts:235/290-292 losing enqueues (background.ts:1385) during awaited sends; no mutex on replayQueuedCaptures (background.ts:1517,2493,2921,5290). Violates P0 Story 17 and PRD.md:953 "no user-visible loss". Not fixed on branch; drain doesn't even forward idempotency ids.

### F13 — Multi-second synchronous CPU (resolve, ONNX embed, cross-encoder, feature builds) runs on the single serving event loop; no general compute lane, stall monitor only observes

- **Severity**: medium · **Effort**: L · **Area**: compute isolation / request path · **Found by**: reliability, performance
- **Files**: packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/recall/embedder.ts, packages/sidetrack-companion/src/recall-v2/rerank.ts, packages/sidetrack-companion/src/recall-v2/learnedRerank.ts, packages/sidetrack-companion/src/runtime/eventLoopMonitor.ts
- **Evidence**: server.ts:1749-1766: resolve builds are '0.5–3 s of CPU each' on the main thread, mitigated only by a 2-permit semaphore — one permit still pins the loop. embedder.ts:116-152 runs ONNX query embedding in-process; rerank.ts:26-37 loads @huggingface/transformers in the main companion process and server.ts:6006-6011 forces rerankTopK=20 on every /v2/recall (~100ms/request per its own comment); learnedRerank.ts:166-167 buildFeatureModel+loadActiveRanker run on-loop; pipeline.ts:1240-1258 inline cross-encoder. eventLoopMonitor.ts:93-108 only console.warns [api.stall]/[api.busy]. Only embeddings have a sidecar (embedder.ts:307-317 setEmbedderOverride).
- **Why it matters**: One Bun process is HTTP + everything; a blocked loop stalls /v1/status, which the extension reads as 'busy', degrading all PRD surfaces at once. Every heavy endpoint historically re-discovers this cliff (repeated 100%-CPU incidents), and wanted features stay gated off citing main-loop CPU.
- **Direction**: Generalize the embedder-sidecar pattern into one shared off-main-loop inference/compute lane (worker pool or child process) serving resolve, rerank, feature builds, and background backfills; wire stall-monitor thresholds to shed or defer optional lanes.
- **Verifier notes**: Core holds: resolve 0.5-3s CPU on-loop w/2-permit cap (server.ts:1749-66); forced rerankTopK=20 in-process cross-encoder (server.ts:6006-11, rerank.ts:26-35); monitor observe-only (eventLoopMonitor.ts:93-108). Refuted: query embed off-process by default (pipeline.ts:1128, companion.ts:694-918); indexer child, retrain worker, reconcile worker also exist — not embeddings-only. Downgrade to medium. | Confirmed: resolve builds 0.5-3s sync CPU on-loop (server.ts:1749-1766), cross-encoder in-process forced topK=20 per /v2 (rerank.ts:24-38, server.ts:6006-6011), monitor observe-only (eventLoopMonitor.ts:93-110). But query embed routes to sidecar by default (companion.ts:907-918, pipeline.ts:1128); learnedRerank is TTL-background not request-path; worst incidents already point-fixed. Degrades P0 surfaces, no data-safety threat.

### F14 — Six weeks of unreviewed work stranded unpushed on one branch with zero CI, no hooks, and the only cross-package gate (e2e incl. §13 BDD specs) manual and flaky

- **Severity**: high · **Effort**: M · **Area**: process / integration risk / quality gates · **Found by**: testing, evolution
- **Files**: package.json, AGENTS.md, scripts/verify-standards.sh, packages/sidetrack-extension/playwright.config.ts, packages/sidetrack-extension/tests/e2e/spec-coverage.spec.ts, docs/milestones/ROADMAP.md
- **Evidence**: .github/ does not exist; .git/hooks/ contains only samples; AGENTS.md:96 says 'wire it into CI' but scripts/verify-standards.sh:4 is the unmodified starter template; root package.json defines `verify` with nothing invoking it automatically. git census: 62 commits ahead of origin/main (+22,545/−2,809 across 343 files); origin/feat/recall-ranker-v2-replacement last pushed 2026-05-27 — 36 commits/+15,299 lines exist only on this machine; last fetch 2026-05-28. e2e is absent from the root verify script; playwright.config.ts:25-34 documents recurring 'SW never appeared after 45s' flake at workers:1/retries:1; the e2e:recorder lane fails SW-attach (fix unapplied); spec-coverage.spec.ts:2 maps tests to a file in /Users/yingfei/Downloads/.
- **Why it matters**: The live dogfood companion and vault run this code as de-facto test bed: every regression reaches real user data before any gate; one disk failure loses six weeks; the eventual merge to main is a 343-file big-bang with no review or CI; PRD ship-blockers (safety chain) have zero automated enforcement.
- **Direction**: Push immediately; slice into a reviewable PR stack; add a GitHub Actions workflow running per-package lint/typecheck/unit on push plus the synthetic-only e2e project on a schedule; fix the recorder lane; vendor the design-spec reference into the repo.
- **Verifier notes**: Confirmed: no .github/, hooks all samples; AGENTS.md "wire into CI" vs verify-standards.sh:4 starter template; root verify lacks e2e; 62 ahead, 36 unpushed since 2026-05-27 (+15,047 lines), fetch 2026-05-28; playwright.config.ts:25-33 SW-45s flake; spec-coverage.spec.ts:2 Downloads path; runtime.ts:487 recorder widening unfixed. File count overstated: 183 not 343. | Confirmed: no .github/, sample-only hooks; verify-standards.sh:4 starter template; package.json:29 verify lacks e2e; playwright.config.ts:27-34 SW flake; spec-coverage.spec.ts:2 Downloads path; 62 ahead/36 unpushed (+15,047) since 2026-05-27. Ship-blocking safety chain (PRD.md:379) gated only by manual flaky requirements-bdd.spec.ts:429. Census overstated: 183 files, not 343.

### F15 — Runner fragmentation: the declared companion test script (vitest under node) silently skips the entire SQLite persistence layer

- **Severity**: high · **Effort**: M · **Area**: testing infrastructure · **Found by**: testing
- **Files**: packages/sidetrack-companion/package.json, packages/sidetrack-companion/src/connections/sqlite-store.test.ts, packages/sidetrack-companion/src/sync/eventStore.test.ts, packages/sidetrack-companion/vitest.config.ts
- **Evidence**: package.json test = `bunx --no-install vitest run` (node runtime; no `--bun` unlike build/lint). sqlite-store.test.ts:16, engagementFactsStore.test.ts:13, timelineFactsStore.test.ts:20, eventStore.test.ts: `process.versions['bun'] === undefined ? it.skip : it` — all SQLite-store tests skip under the declared runner, while SqliteConnectionsStore is the production default. vitest.config.ts coverage thresholds (80/75/80/80) are never enforced: no --coverage flag, and the config is ignored under `bun test`.
- **Why it matters**: The current.json↔current.db byte-equivalence contract is 'enforced only by tests' — and those tests skip under the declared gate. Two runners execute different suites with different vi.mock semantics.
- **Direction**: Pick one authoritative runner per package (bun-native for companion), make the package.json `test` script match it, and delete the dead coverage-threshold config or enforce it.
- **Verifier notes**: Confirmed: package.json:39 test=`bunx --no-install vitest run` (vitest shebang=node, no --bun unlike build/lint); 34 sqliteIt tests skip (sqlite-store.test.ts:16, eventStore.test.ts:9, engagement:13, timeline:20), incl. json→db import test :723. SqliteConnectionsStore default (snapshot.ts:5661-64). Coverage thresholds never enforced; no CI; root verify uses skipping runner. | Confirmed: companion package.json test lacks --bun (vitest shebang=node); 34 sqliteIt tests skip (sqlite-store.test.ts:16 x21, eventStore.test.ts:9 x5, engagement:13, timeline:20). SQLite is prod default (snapshot.ts:5661). Root test script inherits skip; no CI. Downgrade high→medium: latent guardrail gap, dev practice uses bun test, no active defect.

### F16 — Normalized failing baseline: 13-fail/8-file extension unit failures mean the aggregate verify gate cannot pass

- **Severity**: high · **Effort**: M · **Area**: testing infrastructure · **Found by**: testing
- **Files**: packages/sidetrack-extension/vitest.config.ts, package.json
- **Evidence**: Prior session (2026-06-02, capture-master-switch work) recorded a pre-existing 13-fail/8-file baseline on this branch, verified unrelated via stash. Verified today: zero it.skip/test.skip/quarantine markers across packages/sidetrack-extension/src and tests/unit (grep count 0), so the failures are unmarked noise, not quarantined. Not re-run (read-only constraint, live companion attached).
- **Why it matters**: Broken windows: with root `bun run test` red by default, new extension regressions are indistinguishable from baseline noise, and no CI exists to force the baseline back to green.
- **Direction**: Triage the 8 files: fix or explicitly .skip with tracking issues, then require green verify before the branch merges.
- **Verifier notes**: Confirmed without running tests: vitest results cache (packages/sidetrack-extension/.cache/vite/vitest/da39a3ee.../results.json, mtime 2026-07-10) shows 8/131 test files failed on latest run; all 8 exist. Root package.json:25-26 chains extension tests into verify. Zero skip markers; no .github/ CI. "13 tests" count unverifiable (cache is per-file). | Confirmed via vitest cache (packages/sidetrack-extension/.cache/vite/vitest/da39a3.../results.json, mtime Jul 10): same 8 files still failing. Root package.json:24-25 verify aggregates extension `vitest run`; no .github CI; zero skip markers. Real, but indirect for P0/data-safety (companion suite separate) — regraded high→medium.

### F17 — No performance/scale regression harness despite perf being the repo's dominant historical failure mode

- **Severity**: high · **Effort**: L · **Area**: testing infrastructure · **Found by**: testing
- **Files**: packages/sidetrack-companion/src/recall-v2/eval/index.test.ts, packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts
- **Evidence**: Zero *.bench.* files repo-wide; eval/index.test.ts:69: 'latencyP50Ms/P95Ms tracked but not gated'. History: two CPU runaways, 45s /status timeouts, 46-69s POST appends, resolve floods — all found only on the live dogfood vault; documented lesson that a 6-item unit fixture hid a 6.8s leiden rebuild at N=896. burstResilience.test.ts gates correctness, not cost.
- **Why it matters**: Every perf cliff so far shipped to the live vault and cost a multi-day investigation. The fragile revisionId cache-gate chain has no structural guard, so recurrence at current 452k-event scale is expected.
- **Direction**: Build a replayed-corpus perf lane (synthetic event log at real scale) asserting drain-time and hot-route latency budgets; run nightly, never against the live vault.
- **Verifier notes**: Confirmed: eval/index.test.ts:69 comment verbatim; latency computed (harness.ts:353-354) but absent from gated sets (index.test.ts:55-68). Zero bench files (only PoC benchmark.ts). burstResilience.test.ts:121-125 gates call counts, not time. Sole time gates are tiny-scale (hnswReconcileIntegration.test.ts:339 touched=5; materializer.test.ts:1848 deadlock bound). No .github/CI, no perf lane. | Confirmed: no bench files, no CI workflows, eval/index.test.ts:69 verbatim ("latency tracked but not gated"). But not zero coverage: snapshot.test.ts:3079 FX2 relative-speedup guard (N=8100) and hnswReconcileIntegration.test.ts:339 (500ms gate) exist. PRD has no perf SLO; historical incidents lost no data — downgrade high→medium.

### F18 — Extension service worker is a 5.7k-LOC closure with a ~600-line message if-chain, zero direct tests, and eviction-volatile closure state enforcing the no-data-loss capture policy

- **Severity**: medium · **Effort**: L · **Area**: extension background · **Found by**: modularity, testing
- **Files**: packages/sidetrack-extension/entrypoints/background.ts, packages/sidetrack-extension/src/messages.ts, packages/sidetrack-extension/tests/unit/background/
- **Evidence**: background.ts is 5661 lines, one defineBackground closure. runtimeMessageListener (4648) is a sequential guard chain — every message type an `if (isXMessage(message))` block with inline handler — running to addListener at 5254; 74 message types and growing. Closure-captured caches (connectionsCache:4540, privacy gates:473-542, classifyMemo) reset on MV3 SW eviction and are unreachable by unit tests. No test file imports entrypoints/background.ts; tests/unit/background/* cover extracted seams only, while the capture gates (2817-2866) and companion identity pinning (1598-1708) live inside the closure.
- **Why it matters**: CODING_STANDARDS bans central switch statements and implicit service-worker memory state. The captureEnabled kill-switch and no-data-loss capture policy (PRD 6.1.2/privacy) are enforced in exactly this untested closure; regressions there lose user captures silently.
- **Direction**: Replace the guard chain with a typed handler registry keyed by messageTypes; extract gates/transport/identity/privacy subsystems into injected modules under src/background/ (pattern already exists) and unit-test them; keep the entrypoint as thin wiring.
- **Verifier notes**: Confirmed: 5661 lines; if-chains even bigger than claimed (handleRequest 2791-3743 has 53 type branches + listener 4648-5252 ~25); no test imports entrypoint; gates 2817-2866 and pinning 1603ff unexported. CODING_STANDARDS.md:71/:105/:10 violated. Overstated: durable buffer is IndexedDB (3908, tested); kill-switch reads fresh (519); eviction risk is minor.

### F19 — Five hand-rolled companion transports; bridge key escapes the service-worker boundary into content scripts on provider pages

- **Severity**: medium · **Effort**: M · **Area**: extension-companion boundary · **Found by**: modularity
- **Files**: packages/sidetrack-extension/src/companion/client.ts, packages/sidetrack-extension/entrypoints/background.ts, packages/sidetrack-extension/src/annotation/client.ts, packages/sidetrack-extension/entrypoints/content.ts
- **Evidence**: x-bac-bridge-key header set in five independent transport implementations: typed client (client.ts:483), companionJson (background.ts:433-438), fetchConnectionsHttp (background.ts:4543-4554), raw fetches (background.ts:4153, 5337-5544), and annotation/client.ts:109 — the last reads the key from chrome.storage and fetches directly from content-script context on provider pages (content.ts:481, 857).
- **Why it matters**: Timeout, error classification, and auth handling drift per copy (past busy-vs-down misclassification bugs). The bridge key living in third-party-page content-script world weakens the intended SW-only credential boundary.
- **Direction**: Consolidate on one SW-resident transport; make the content-script annotation path SW-proxy-only (test fixture can stub the SW route).
- **Verifier notes**: All cited sites verified: client.ts:483 (only transport with timeout signal :519), background.ts:438/4554/4153/5337/5401, annotation/client.ts:108 fetches with key read from chrome.storage (:66), called from content.ts:481/857 — a defineContentScript matching all http(s) pages (:425). Undercounted: ~9 more independent transports. Isolated-world + SW fallback keeps it medium.

### F20 — Two parallel event-persistence lanes split truth; asymmetric replay dedupe (1h receipts vs permanent clientEventId) mints divergent duplicate captures on late replay

- **Severity**: medium · **Effort**: L · **Area**: storage boundaries / replay idempotency · **Found by**: modularity, integrity
- **Files**: packages/sidetrack-companion/src/vault/writer.ts, packages/sidetrack-companion/src/sync/eventLog.ts, packages/sidetrack-companion/src/http/idempotency.ts, packages/sidetrack-companion/src/http/server.ts
- **Evidence**: Causal log _BAC/log/<replicaId>/ (eventLog.ts:50-53, 273) coexists with legacy per-day JSONL: captures _BAC/events (writer.ts:516-517), dispatches (536-537), reviews (672-673) via plain flag:'a' appendJsonLine without causal identity or dedupe dots (writer.ts:217-220). POST /v1/events double-writes: writer.writeCaptureEvent mints a fresh bac_id every call (background.ts:878-880 comment) then appends CAPTURE_RECORDED with clientEventId=idempotencyKey (server.ts:6288-6314). Receipts expire after 1h (idempotency.ts:24: 'a later replay simply re-runs the operation') — the causal log dedupes forever but the legacy lane re-runs, minting a duplicate capture under a new bac_id that rebuild's dedupe-by-bac_id cannot collapse.
- **Why it matters**: Capture/dispatch/review data is excluded from the sync-contract truth path, so multi-replica sync and rebuild guarantees don't cover it — the vault-is-canonical anchor holds only partially. Late replays are real (multi-day offline outbox retries, user-triggered Retry banner), producing divergent duplicates between the two 'source of truth' lanes.
- **Direction**: Migrate legacy writer appends onto the causal event log so CAPTURE_RECORDED is the single capture truth (or dedupe the legacy writer by an idempotencyKey-derived content-stable capture id); document which _BAC subtrees are truth vs derived.
- **Verifier notes**: Confirmed all cites: fresh bac_id writer.ts:511+516, flag:'a' 217-220, double-write server.ts:6288-6314, 1h TTL + budget eviction idempotency.ts:24/99-111, permanent clientEventId dedupe eventLog.ts:892-904, rebuild skips only known bac_ids rebuild.ts:278-290. Auto-retries (~28min, outbox.ts:160-176) stay inside TTL; exposure = Retry banner/SW-stall/receipt-eviction tail. Medium stands.

### F21 — Connections god-modules: 4k-line materializer closure with hard-disabled experiment lanes whose docs claim they are ON; snapshot.ts fuses pure builder with two stores

- **Severity**: medium · **Effort**: XL · **Area**: connections/graph subsystem · **Found by**: modularity, evolution
- **Files**: packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts, packages/sidetrack-companion/src/connections/snapshot.ts, packages/sidetrack-companion/src/connections/hotPathMode.ts, packages/sidetrack-companion/src/connections/topicShadowCandidate.ts
- **Evidence**: createConnectionsMaterializer (connectionsMaterializer.ts:1085) is one closure through drain() at 4524 in a 5243-line file — scheduling, cache gates, topic promotion, shadow A/B, worker forking. Dead lane shipped: `const hotSimilarityMode = !persistentHnswSimilarityMode && false` (3022, doubly dead — 2795/447 make the left operand always false too) while hotPathMode.ts:1-24 documents hot-similarity as 'now ON by default'. Facts-store lanes kept opt-in after being measured net-negative (materializer:449-457); idf-rkn shadow lane retained after leiden-cpm default (servedTopicProducer.ts:24). snapshot.ts (5927 LOC) holds pure buildConnectionsSnapshot (1443) plus SqliteConnectionsStore class (4047) plus JSON store; current.json/current.db byte-equivalence enforced only by tests (which skip under the declared runner).
- **Why it matters**: Multiple CPU-runaway incidents originated in this branch matrix; invariants live in prose comments and ~20 env flags; every dormant lane multiplies untested interactions, and the ON-by-default comment will mislead the next change. This is the highest-churn code on the branch.
- **Direction**: Delete hard-disabled lanes and excise rejected facts-store lanes; time-box the topic shadow A/B with a removal date; split the materializer into scheduler/cache-gate/topic-promotion modules with explicit revision-id contracts; extract stores from snapshot.ts behind the existing ConnectionsStore port.
- **Verifier notes**: All cited lines verified: `&& false` at connectionsMaterializer.ts:3022 (doubly dead via :447); hotPathMode.ts:1-2 still claims ON-by-default, flag only read by workGraphHealth.ts:631; facts-store opt-in :454-457; snapshot.ts 5927L builder:1443/SqliteStore:4047/JSON:5654; sqlite-store.test.ts:16 skips under package.json:38 vitest runner.

### F22 — Polling serve path pays O(lifetime-history) recompute and full serialization before any cache/304 short-circuit: whole-log-signature invalidation, untyped folds, post-hoc ETags, per-request thread-directory scans

- **Severity**: low · **Effort**: M · **Area**: http serving / caching · **Found by**: performance
- **Files**: packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/urls/projection.ts
- **Evidence**: server.ts:2337-2352, 2364-2380: url/tab-session caches keyed on whole-log signature; a miss triggers untyped store.forEachChunk over all 637k events (or full readMerged) though the fold consumes only 4 types (urls/projection.ts:352,404,427,450); any append flips the signature — including recall.served impressions the serve path itself writes (server.ts:5990-5999), a self-feeding churn pattern. computeBodyEtag runs only after route.handle returns (7897-7907); :746-754 stringifies the body twice; a 304 still costs full handler + serialize — the sha256→FNV swap comment (:707-716, 1.18M SubtleCrypto instances at ~2 req/s) proves the path is hot. readWorkstreamThreadIds (:931-956) and readThreadSuggestionTarget (:960-987) readdir + JSON.parse every _BAC/threads/*.json per call, invoked per recall-with-workstream-filter (:5637) and per thread-suggestion request (:6213), which the panel fans out per visible thread.
- **Why it matters**: The polling-first client design (15s panel poll + 1-min alarms) multiplies per-poll CPU that grows forever with history and response size; 304s save bandwidth, not compute; whole-log invalidation granularity means serving recall invalidates unrelated projection caches — the same shape as prior fan-out incidents.
- **Direction**: Typed forEachChunkOfTypes plus watermark-resumable incremental folds (accumulators already exist); per-type log sub-signatures for cache keys; pre-handler cheap validators per route family (snapshotRevision, log signature) to short-circuit 304s; single stringify; memoized thread index keyed by log signature.
- **Verifier notes**: Cites accurate: untyped forEachChunk fallback (server.ts:2349,2376), post-handler ETag+double stringify (7884-7907,744,754), recall.served appends (5993), whole-log sig (eventLog.ts:566-581). But overstated: polls are snapshot-first (server.ts:2480-2537, materializer:3934) and thread scans TTL-cached (1642-1672,6209); O(history) fold is fallback-only.

### F23 — Scoped-delta IVM is an enumerated special-case matrix; any gate miss pays a full rebuild that grows with the vault

- **Severity**: medium · **Effort**: L · **Area**: connections materializer · **Found by**: performance
- **Files**: packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts
- **Evidence**: connectionsMaterializer.ts:3821-4010: accreted else-if chain — bounded scoped delta, threadFullBuildReason (3864-3870), revisit-no-op, catch-up empty-scope branch (3985-4009, added after a frontier-freeze runaway). Full 13-pass buildConnectionsSnapshot remains the fallback; branch comments document each case was added after a ~16-18s incident. Live graph: 10.5k nodes, 15.9k edges after ~2 months.
- **Why it matters**: Coverage is proven only for anticipated event mixes; the next unanticipated mix re-pays a full rebuild whose cost keeps growing with graph and history size.
- **Direction**: Emit an alarmed diagnostics counter + drain budget whenever the full-rebuild fallback fires; add event-mix property tests; longer term, a general delta engine.
- **Verifier notes**: Confirmed: 11-condition AND gate (connectionsMaterializer.ts:3686-3698) + enumerated invalidation kinds (1736-1761) + else-if chain 3821-4030 with incident comments (3964-3966 "~18s rebuild", 3998-4003 frontier-freeze); gate miss falls back to full 13-pass buildConnectionsSnapshot over complete history (4047-4068; snapshot.ts:1419-1440). Nuance: catch-up misses throw, not rebuild; skip-reason mark exists (4033).

### F24 — SQLite store lifecycle unmanaged: no schema-version/migration story (any version bump forces full-history recompute) and no WAL checkpointing or monitoring across five stores

- **Severity**: medium · **Effort**: M · **Area**: storage upgrades / SQLite hygiene · **Found by**: performance, integrity
- **Files**: packages/sidetrack-companion/src/sync/reproject.ts, packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts, packages/sidetrack-companion/src/sync/eventStore.ts, packages/sidetrack-companion/src/connections/snapshot.ts, packages/sidetrack-companion/src/recall-v2/store/sqlite.ts, packages/sidetrack-companion/src/engagement/engagementFactsStore.ts, packages/sidetrack-companion/src/timeline/timelineFactsStore.ts
- **Evidence**: reproject.ts:21 PROJECTOR_VERSION=1 mismatch → full vault re-walk; connectionsMaterializer.ts:310 MATERIALIZER_VERSION is a hand-edited string and :1133 mismatch invalidates all progress → full resync over 637k events. rg 'user_version' across companion src: zero hits; all SQLite schemas are CREATE IF NOT EXISTS. All five stores set journal_mode=WAL (snapshot.ts:4117-4119, eventStore.ts:92, sqlite.ts:49-50, engagementFactsStore.ts:92-93, timelineFactsStore.ts:66-67) but repo-wide grep finds no wal_checkpoint, wal_autocheckpoint tuning, or WAL-size monitoring; a prior 1.8GB current.db WAL required manual PRAGMA wal_checkpoint(TRUNCATE); fork-per-drain children plus the main process share these DBs, stalling passive checkpointing.
- **Why it matters**: Rebuild-as-upgrade cost scales with lifetime log: on a years-old vault every release that bumps a version stalls the companion for minutes and re-bloats WALs; unbounded silent disk growth inside a synced folder was already observed once in dogfood.
- **Direction**: Adopt SQLite user_version with additive migrations for derived stores, reserving full recompute for shape changes; periodic wal_checkpoint(TRUNCATE) during idle/drain-complete hooks; WAL-bytes gauge and rebuild progress surfaced in /v1/system/health.
- **Verifier notes**: Confirmed: no user_version/ALTER TABLE/migrations anywhere; version mismatch forces full recompute (reproject.ts:21,106-127; connectionsMaterializer.ts:310,1133,2138,2419). Only PRAGMAs are WAL+busy_timeout at all five cited lines; zero wal_checkpoint/autocheckpoint/monitoring. Child process shares snapshot DB (connectionsReconcileChild.entry.ts:9-13). Only quibble: 637k-event count unverified (~452k on 2026-06-28).

### F25 — Write-path durability/atomicity gaps: zero fsync anywhere in the acknowledged path, and most externally-visible vault JSON/Markdown writes are non-atomic despite an existing atomic primitive

- **Severity**: medium · **Effort**: M · **Area**: vault write durability · **Found by**: integrity, modularity
- **Files**: packages/sidetrack-companion/src/vault/atomic.ts, packages/sidetrack-companion/src/sync/eventLog.ts, packages/sidetrack-companion/src/vault/writer.ts, packages/sidetrack-companion/src/sync/projectors.ts, packages/sidetrack-companion/src/runtime/companion.ts, packages/sidetrack-extension/src/companion/outbox.ts
- **Evidence**: Repo-wide grep finds zero fsync/fdatasync calls. Log appends are writeFile flag:'a' unsynced (eventLog.ts:928-932, 988-992, 1042-1046); writeFileAtomic is tmp+rename without fsync of file or directory (atomic.ts:6-17); legacy appendJsonLine same (writer.ts:217-220). Per-aggregate projections use plain writeFile (projectors.ts:114); writer.ts writeJson (:199-201) and markdown sidecars (:207-215) likewise — only settings/coding paths use writeJsonAtomic (:747, 1150, 1200). Torn thread JSON makes readJsonRecord throw (:222-229), wedging subsequent upserts of that aggregate; anti-entropy repairs projections only every 30min (companion.ts:568-578). The extension outbox drops items after HTTP 200 (outbox.ts:253-256, 290-292), so OS-crash losses are unrecoverable.
- **Why it matters**: Syncthing, Obsidian, and the MCP LiveVaultReader read these files directly — a crash mid-write ships torn state to peers and can wedge a thread aggregate until manual repair; OS crash/power loss silently loses events already acknowledged to the extension (PRD §15 scopes durability only to companion/Chrome restarts, and that posture is undocumented).
- **Direction**: Route writeProjection, writeJson, and markdown sidecars through writeFileAtomic; treat unparseable existing docs as absent with an audit entry instead of throwing; add opt-in fdatasync on explicit-capture and dispatch appends plus fsync-before-rename for replica-seq and bridge-key files; document the durability posture explicitly.
- **Verifier notes**: All cites verified: no fsync repo-wide; unsynced flag:'a' appends eventLog.ts:928/988/1042; atomic.ts:6-17 rename-only; writer.ts writeJson:198, sidecar:207, appendJsonLine:217, torn-JSON throw:222 rethrown in upsertThread:762; projectors.ts:114; 30min antiEntropy.ts:77; outbox drops post-200 (253-256,290-292). recovery.ts is recall-only, not a repair path. PRD.md:1165 confirms scope.

### F26 — Event pipeline silently drops data with no detection or repair: SQLite mirror permanently skips out-of-order shard events; corrupt/torn log lines swallowed uncounted at every layer; no fsck tooling

- **Severity**: medium · **Effort**: M · **Area**: corruption/divergence detection · **Found by**: integrity
- **Files**: packages/sidetrack-companion/src/sync/eventStore.ts, packages/sidetrack-companion/src/sync/eventLog.ts, packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts, packages/sidetrack-companion/src/cli.ts
- **Evidence**: catchUpFromJsonl skips any event with seq <= MAX watermark (eventStore.ts:355, watermark bumped by MAX at :193-195) — a peer shard arriving after a newer shard (Syncthing syncs files independently) is dropped forever; rebuildFromJsonl (:369-376) has zero production callers; only the connections lane self-heals via dot-interval gap backfill (connectionsMaterializer.ts:2480-2490) while recall ingestor, reproject, workGraphHealth, and urls/autoApply consume the mirror unchecked. parseLine returns null on any bad line (eventLog.ts:310-319) and readLogFile drops it uncounted (:342-344); the store skips malformed lines (:358-360) and invalid rows (:156-158) the same way. No counter, quarantine, checksum, or health surfacing; cli.ts offers models/recall verify (:139,149) but no event-log fsck.
- **Why it matters**: With SIDETRACK_EVENT_STORE=1 (the perf direction the branch depends on), derived reads silently diverge from the JSONL source of truth with no reconciliation, health signal, or repair path short of hand-deleting the db. An acknowledged event whose line is later torn vanishes from every projection with zero signal — unfalsifiable against the PRD zero-data-loss criterion.
- **Direction**: Track per-shard applied dot-intervals (not a dense watermark) in the store; count skipped/malformed lines per shard and surface both plus count-vs-JSONL reconciliation in /v1/system/health; quarantine bad lines to a sidecar; wire rebuildFromJsonl as the repair and add a `log verify` CLI.
- **Verifier notes**: All citations verified: watermark skip eventStore.ts:258/355 (MAX bump :193-196), rebuildFromJsonl :369-376 test-only, ~15 unchecked store consumers (recall/ingestor.ts:142, reproject.ts:71, workGraphHealth.ts:292, server.ts:2262), malformed lines uncounted (eventLog.ts:310-344, eventStore.ts:156/358), no fsck CLI. Slight overstatement: connections gap-backfill (:2480) heals shared store for interior gaps; tail-loss stays invisible.

### F27 — No last-resort crash handling or supervision for the sole vault writer; service install exists but is optional and unverified

- **Severity**: medium · **Effort**: M · **Area**: companion process lifecycle · **Found by**: reliability
- **Files**: packages/sidetrack-companion/src/cli.ts, packages/sidetrack-companion/src/install/launchd.ts, packages/sidetrack-companion/src/runtime/companion.ts
- **Evidence**: No process.on('uncaughtException'/'unhandledRejection') anywhere in the main process (only child entries handle 'message'); cli.ts:1106-1125 wires SIGINT/SIGTERM only. --install-service IS implemented (cli.ts:282, launchd.ts:34-35 KeepAlive) — contradicting the ADR-0001 'v1.5 unshipped' assumption — but dogfood runs unsupervised screen sessions.
- **Why it matters**: A single unexpected throw in any of the many timers/fire-and-forget paths kills capture ingestion, the MCP child, and all materializers with no post-mortem log and no respawn until the user notices the badge.
- **Direction**: Add uncaughtException/unhandledRejection handlers that log structured post-mortem and exit cleanly; make --install-service the documented default install path.
- **Verifier notes**: Confirmed: zero uncaught/unhandled handlers in companion src; cli.ts:1120-1125 SIGINT/SIGTERM only; --install-service real (cli.ts:282, launchd.ts:35 KeepAlive) but install-companion.sh:59 runs foreground. Exaggerated blast radius: Bun logs-and-continues on unhandled rejections; HTTP handlers try/catch→500 (server.ts~7876-7940); timers locally guarded. Sync throws in unguarded callbacks still fatal, no post-mortem.

### F28 — Observability baseline unmet and health edges dishonest: no metrics/spans/structured logs; service.running is plist-existence; learned-rerank failures and MCP-child death invisible

- **Severity**: medium · **Effort**: M · **Area**: observability / degraded-mode surfacing · **Found by**: reliability
- **Files**: packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-companion/src/runtime/eventLoopMonitor.ts, packages/sidetrack-companion/src/install/launchd.ts, packages/sidetrack-companion/src/install/systemd.ts, packages/sidetrack-companion/src/recall-v2/learnedRerank.ts, packages/sidetrack-companion/src/cli.ts, standards/00-engineering-baseline.md
- **Evidence**: standards/00-engineering-baseline.md:58-64 requires trace/span, structured logs, and latency/error/retry metrics per operation. Reality: no otel/prom/pino deps in package.json; ~41 bare console.* lines; the only request log is opt-in SIDETRACK_HTTP_LOG=1 appending plaintext to /tmp (server.ts:7882-7890); stall telemetry is free-text console.warn (eventLoopMonitor.ts:97-107). launchd.ts:72-75 and systemd status(): `running: installed` — file existence, never launchctl/systemctl query — served via /v1/system/health (server.ts:4179-4186). learnedRerank.ts:177-180: refresh failure only console.warns, stale model/gate served indefinitely. cli.ts:340-344: MCP child exit just writes a stderr line.
- **Why it matters**: Every past incident (CPU runaways, resolve floods, 45s timeouts) required bolting on ad-hoc logging first — 'endpoint-guessing failed ~5×' is recorded project history. collectHealth itself is carefully honest (timedOut→unavailable, worst-of at health.ts:244-276), but these edges report green while degraded — the exact misleading-metric failure the health work targeted.
- **Direction**: Adopt one structured logger with requestId/operation/latency/outcome fields, always-on at info to a rotating vault-local file; add a minimal counter registry to /v1/status; query launchctl/systemctl for real running state; add learnedRerank and MCP-child liveness health sections with lastError.
- **Verifier notes**: All citations verified: baseline.md:58-64 mandates spans/structured-logs/metrics; no logging deps in package.json; 43 console.* lines; opt-in /tmp HTTP log server.ts:7882-7890; launchd.ts:72-75+systemd.ts:55-58 running=file-exists, served via server.ts:4179-4182, health.ts:252 marks 'ok'; learnedRerank.ts:177-181 warn-only; cli.ts:340-344 MCP exit=stderr line, no respawn. Minor nuance: eventLoopMonitor exports counters to /v1/status.

### F29 — Vault-unreachable is a load-bearing stringly-typed error, and the PRD §9 in-memory write buffer is absent

- **Severity**: low · **Effort**: S · **Area**: typed errors / failure modes · **Found by**: reliability
- **Files**: packages/sidetrack-companion/src/vault/writer.ts, packages/sidetrack-companion/src/http/server.ts
- **Evidence**: writer.ts:419-424 throws bare `new Error('Vault path is unavailable.')`; server.ts:7919-7921 maps 503/VAULT_UNAVAILABLE by exact message string-compare. The extension's 'vault-error' panel state depends on this code. PRD.md:945 specifies the companion buffers writes in-memory (cap 100) — no such buffer exists; writes just fail.
- **Why it matters**: Violates standards/00-engineering-baseline.md:37 ('typed errors, convert at the boundary'); any message-text edit silently turns vault outages into 500 INTERNAL_ERROR, breaking the extension's failure classification with no test tripwire.
- **Direction**: Introduce a VaultUnavailableError class matched via instanceof in the funnel; decide and record whether the PRD buffer is superseded by the extension outbox.
- **Verifier notes**: Confirmed: writer.ts:423 bare Error, server.ts:7920 string-compare, PRD.md §9 buffer absent (writes 503, server.test.ts:463 codifies reject). But impact overstated: 4 tests (server.test.ts:488,641,1319,1452) tripwire message drift, and extension vault-error uses /v1/status vaultWriter.status() (writer.ts:500-506, background.ts:1707), not the string.

### F30 — Companion loopback/debug hardening gaps: default-open extension origins, unauthenticated debug heap dump, route-match before auth, and PII (queries/URLs) in a world-readable /tmp log under the habitual debug flag

- **Severity**: medium · **Effort**: S · **Area**: loopback-server hardening / PII in debug sinks · **Found by**: security
- **Files**: packages/sidetrack-companion/src/http/server.ts
- **Evidence**: isAllowedOrigin accepts ANY chrome-extension:// origin unless SIDETRACK_ALLOWED_EXTENSION_IDS is set (server.ts:796-801). With DEBUG_HEAP_SNAPSHOT=1, POST /debug/heap-snapshot is authRequired:false (2540-2550) and writes the full Bun heap — vault content plus in-memory bridge key — to tmpdir with default perms (647-650). handleRequest matches routes (7798) before origin/auth gates (7819, 7833), so 404-vs-401/403 enumerates the API; /v1/version returns vaultRoot+codePath unauthenticated (2592-2609). With SIDETRACK_HTTP_LOG=1 — the team's standard diagnostic tool — every request appends pathname+search to /tmp/sidetrack-http-debug.log at default 0644 (7887-7890), capturing recall queries in q= (5536-5542) and visited URLs in url= (5342, 7220).
- **Why it matters**: Bridge-key auth itself is solid (0600 file, timingSafeEqual), but one debug env flag or one hostile co-installed extension erodes the local trust boundary the whole privacy story rests on; in practice search queries and browsing URLs from a privacy-first product accumulate indefinitely in a world-readable temp file.
- **Direction**: Make debug routes authRequired; move origin/host gates before route match; ship an extension-id allowlist by default in packaged builds; log pathname only (or redact q=/url=), create the log 0600 with a size cap.
- **Verifier notes**: All four claims verified at cited lines: open chrome-extension origins (server.ts:796-801), unauth heap dump (2540-2550, 647-648), route-match-before-gates (7798/7819/7833) plus ACAO:* (683) making enumeration web-readable, /v1/version leaks vaultRoot+codePath (2592-2613). Live /tmp log is 0644 with 104 url= entries. Medium stands.

### F31 — Token-budget warning is fixed-threshold, fires after the dispatch is recorded, and the panel never surfaces it

- **Severity**: medium · **Effort**: M · **Area**: token-budget warnings (PRD 6.1.13) · **Found by**: security
- **Files**: packages/sidetrack-companion/src/safety/tokenBudget.ts, packages/sidetrack-companion/src/http/server.ts, packages/sidetrack-extension/src/safety/preflight.ts
- **Evidence**: tokenBudgetWarningThreshold is a hardcoded 8000 (tokenBudget.ts:7), not the target model's context window. The real cl100k count runs only inside POST /v1/dispatches after persistence, returning warnings:['token-budget-exceeded'] (server.ts:4589-4591) — the only extension reference to that string is a unit test, so the live panel drops it. Extension preflight uses char/4 with a blanket 200K limit (preflight.ts:25-30).
- **Why it matters**: PRD 6.1.13 lists token-budget warnings as ship-blocking user-facing feedback. Today the accurate warning is computed and then discarded; users only ever see the char/4 composer estimate, so oversized packets fail silently at the provider.
- **Direction**: Surface the companion warning in DispatchConfirm/RecentDispatches; parameterize threshold per target provider's context window.
- **Verifier notes**: Confirmed: tokenBudget.ts:7 hardcodes 8000; server.ts:4548 persists then :4589-91 attaches warning; client.ts:56-62 parses warnings but no consumer reads .warnings (App.tsx:4084-4131, background.ts:3448-75 use only bac_id/tokenEstimate); sole 'token-budget-exceeded' ref is dispatch.test.ts:83. preflight.ts:25,30 char/4 vs blanket 200K. PRD:948 requires pre-dispatch context-window warning.

### F32 — §6.1.14 MCP write surface incomplete: new_cluster/link_items tools missing and typed links have no substrate; untrusted calls hard-403 with no approval fallback

- **Severity**: medium · **Effort**: M · **Area**: MCP write tools (P0) · **Found by**: product-gap
- **Files**: packages/sidetrack-mcp/src/server/mcpServer.ts, packages/sidetrack-companion/src/auth/workstreamTrust.ts
- **Evidence**: Full tool-name enumeration of mcpServer.ts shows no workstream-create or link tool (threads.move :469, queue.create :502, session.attach cover 3/5). Typed links themselves are absent repo-wide (zero hits for source_of/coding_session_for/dispatched_to), so link_items has no substrate. Untrusted calls hard-403; no approval-modal fallback per the PRD's interactive-approval model.
- **Why it matters**: PRD moved MCP write tools into MVP per Q1/Q7; without new_cluster/link_items the coding-agent integration point cannot fulfill the P0 write surface, and the typed-link gap is object-model work that will not shrink on its own.
- **Direction**: Add the new_cluster tool (small); typed-link entity is object-model work — decide build vs formally deferring link_items in the PRD.
- **Verifier notes**: Confirmed: no new_cluster/link_items tool (mcpServer.ts:325-1081, capabilities.ts:5-54; 3/5 PRD tools exist), typed links zero repo hits, deny=terminal 403 WORKSTREAM_NOT_TRUSTED (http/server.ts:1339-1346) with no approval modal. Nuance: trust is allow-by-default (workstreamTrust.ts:77), so only explicit denies 403 — "hard-403 for untrusted" overstated.

### F33 — Capture/recovery resilience gaps: no clipboard fallback for broken selectors, chrome.sessions never wired (restore_session branch unreachable), no per-site tracking toggle

- **Severity**: medium · **Effort**: M · **Area**: capture + tab recovery (P0) · **Found by**: product-gap
- **Files**: packages/sidetrack-extension/entrypoints/content.ts, packages/sidetrack-extension/entrypoints/sidepanel/App.tsx, packages/sidetrack-extension/entrypoints/sidepanel/components/TabRecovery.tsx, packages/sidetrack-extension/entrypoints/background.ts
- **Evidence**: Canary detection exists (content.ts:1432-1475) but zero clipboard-capture code in the extension — broken selectors degrade with no escape hatch (§6.1.2). chrome.sessions/browser.sessions: zero hits; App.tsx:543-544 restoreStrategyForThread only returns 'reopen_url'|'focus_open', so TabRecovery's 'restore_session' branch (TabRecovery.tsx:3-8) is unreachable. Tracking gate is global settings.autoTrack + per-thread modes (background.ts:2834-2857); no per-site toggle.
- **Why it matters**: §15 success criteria require tracking ≥80% of AI work and recovering a closed tab; these are the resilience paths that keep those criteria true when selectors break or tabs close.
- **Direction**: Wire chrome.sessions.getRecentlyClosed into the existing strategy enum (small); add a per-site toggle; decide clipboard-mode build-vs-defer and record it.
- **Verifier notes**: All confirmed: zero chrome.sessions/getRecentlyClosed hits; App.tsx:544 returns only reopen_url|focus_open and App.tsx:8273-8294 never passes onRestoreSession (TabRecovery.tsx:61 branch dead); background.ts:2833-2857 gate ignores siteToggles (workboard.ts:178 field is defined but never read). Stronger: SystemBanners.tsx:72 advertises a clipboard fallback that doesn't exist (PRD.md:243,947).

### F34 — Planning/decision docs frozen while the branch ships M3 scope: PRD deviations unrecorded (step 15 unpassable as written), ROADMAP at 'M1 building', five architecture shifts with no ADR

- **Severity**: medium · **Effort**: M · **Area**: docs/decision-record drift · **Found by**: evolution, product-gap
- **Files**: PRD.md, docs/milestones/ROADMAP.md, docs/adr, packages/sidetrack-companion/src/sync/eventStore.ts, packages/sidetrack-companion/src/connections/snapshot.ts, packages/sidetrack-companion/src/vault/writer.ts, packages/sidetrack-companion/src/vault/markdownProjection.ts
- **Evidence**: ROADMAP.md:18-21: M1 'building' (PR #13), M2 'planning', M3 'sketch'; last commit touching it 2026-05-16; zero docs/ commits across the entire branch while M2 dispatch/safety/review shipped and M3-scope vector recall + learned ranker absorbed 34/62 unmerged commits. docs/adr newest is 0005 (2026-05-16); undocumented since: SQLite event mirror (eventStore.ts:183), SqliteConnectionsStore as default store (snapshot.ts:4104), sqlite-vec recall-v2 index (recall-v2/store/sqlite.ts:45), IVM-only with opt-out removal (connectionsMaterializer.ts:444), impression-trained ranker serve gates (learnedRerank.ts:141-157). Unrecorded PRD divergences: sidetrack.* tools not bac.* (§13 step 15 'npx bac-mcp'/'bac.context_pack' can never pass), streamable-HTTP :8721 not WebSocket (§6.2.6), reviews to _BAC/reviews/<date>.jsonl (writer.ts:669-675) not frontmatter (§6.1.10), checklist as '## Checklist' body section (markdownProjection.ts:106-112) not frontmatter (§6.1.6), hybrid /v2 vector recall live vs §6.1.8 'lexical only'.
- **Why it matters**: The PRD claims acceptance authority (§2) and CLAUDE.md/AGENTS.md make ADRs plus architectural anchors the binding override hierarchy for all coding agents — decisions living only in commit messages and out-of-repo agent memory cannot bind future agents, and the stated planning artifact inverts actual priority.
- **Direction**: One decisions-log pass (rename step 15 to sidetrack.*, bless JSONL review/checklist storage and streamable-HTTP, mark vector recall delivered-early P1); 4-5 short retroactive ADRs (SQLite substrates, IVM-only, learned-ranker serving policy, setup-sqlite import-order invariant); one-hour ROADMAP refresh listing open P0 gaps.
- **Verifier notes**: Verified all citations: ROADMAP.md:18-21 M1-building, ADRs end at 0005 (2026-05-16), PRD.md:1124-25 bac.context_pack vs sidetrack.* tools (capabilities.ts:5), writer.ts:669-675 JSONL reviews, markdownProjection.ts:105-112 body checklist, connectionsMaterializer.ts:444-447 IVM-only, learnedRerank.ts:141-157 gates. One overstatement: eaf89076 added a docs/design doc on-branch, so "zero docs commits" is false; decision docs still frozen.

### F35 — Env-flag lifecycle debt: 86 undocumented SIDETRACK_* flags with no registry; removed opt-outs left tests toggling dead flags, making the IVM equivalence suite vacuous

- **Severity**: medium · **Effort**: M · **Area**: configuration debt / test integrity · **Found by**: evolution
- **Files**: packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts, packages/sidetrack-companion/src/connections/hotPathMode.ts, packages/sidetrack-companion/src/sync/contract/connectionsHnswReconcileIntegration.test.ts, packages/sidetrack-companion/src/sync/contract/connectionsClassBIntegration.test.ts, INSTALL.md
- **Evidence**: rg census: 88 unique SIDETRACK_* tokens in companion src (86 real); 75 non-test process.env reads across 17 files; INSTALL.md documents exactly one (SIDETRACK_MODELS_DIR). Mix: ~10 permanent config, ~20 tuning knobs, ~15 live experiments, ≥6 dead/dormant. connectionsMaterializer.ts:444-447 hardcodes incrementalRankerEnabled/incrementalSimilarityEnabled to true ('env-opt-out removed') yet SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY (20 refs), _DRIFT_DISABLED, and _INCREMENTAL_RANKER have zero non-test readers; connectionsHnswReconcileIntegration.test.ts:592-596 builds a 'pairwise' control vault with flag='0' — both vaults actually run the incremental path, so the HNSW-vs-pairwise comparison compares incremental to itself.
- **Why it matters**: Flag semantics live only in code comments and out-of-repo agent memory; incidents (U2 runaway) traced to flag interactions nobody could enumerate; the byte-determinism/equivalence regression net — the declared safety invariant of IVM — silently stopped testing the thing it names; config is unreproducible on a second machine.
- **Direction**: Central flags module (name, default, status permanent/experiment/deprecated, owner, retire-by) with a generated docs table; delete dead flags in the same pass; rewrite the pairwise-equivalence test against an injected legacy implementation or delete it honestly.
- **Verifier notes**: Confirmed: 88 flags, INSTALL.md documents 1; connectionsMaterializer.ts:446-447 hardcodes both enables true (:2795 uses it); INCREMENTAL_SIMILARITY/_RANKER/_DRIFT_DISABLED/_SCOPES have zero non-test readers repo-wide; HnswReconcile test:591-615 and classB test:846-865 compare flag-on vs flag-off vaults that run identical code. Minor: docs/architecture.md lists 11 flags.


---

## 3. Roadmap

### The three candidates

### Candidate: mvp-first

The §13 acceptance scenario hard-fails at step 7 today while ~63k LOC of post-MVP P1 systems compound on an unpushed 247-commit branch riding a live vault; the actual distance to "MVP ships" is days-scale UI/plumbing (checklist UI, Inbound/Queued views, queue→packet, export route, chrome.sessions) plus one ship-blocking safety inversion (redaction sanitizes the audit copy, not the outbound text). Sequence: (1) protect the work and the vault in days — push, CI, green baseline, the four data-loss/privacy patches; (2) invert the safety chain and close the four broken §13 steps in weeks 1–3 under a hard P1 freeze; (3) merge to main and run a recorded, honest 16-step demo with minimum durability tripwires for the 30-day §15 window; (4) only after the demo passes, unfreeze the architecture backlog. Architectural work is admitted only where it blocks a §13 step or can lose data during dogfood — everything else waits.

### Candidate: stability-first

The live dogfood rig IS the product, and it currently runs ~63k LOC of post-MVP intelligence on a base that exists on one disk (247 unpushed commits, no CI), can lose acknowledged data on power loss or SW eviction, and sends secrets to providers unredacted while sanitizing only the local audit copy. Sequence: one week to stop the existential bleeding (push, CI, S-sized safety flips), four weeks of durability and outbound-safety so the vault-is-canonical promise is actually true, five weeks raising the storage/CPU ceilings so 30 days unattended is physically possible, then a days-scale §13 closure sprint and the 30-day §15 window to declare MVP. Recall/ranker/connections investment stays frozen until the acceptance scenario passes — the branch history (43 of 62 visible commits on P1 systems while step 7 of §13 hard-fails) is the drift this roadmap exists to reverse.

### Candidate: leverage-reality

Reality outran the PRD: the branch already ships M3-scope tech (29k LOC connections graph, 19k LOC hybrid vector recall, 15k LOC learned ranker — §6.3.1/§6.3.6 territory) working in daily dogfood, while the MVP gate fails on days-scale UI/plumbing (§13 breaks at steps 7/9/11/13) and two inverted ship-blockers (redaction applied to the stored copy instead of the outbound text; privacy defaulting open). The expensive failure mode for a single dev with cheap agent labor is not missing features — it is the unpushed 247-commit branch with no CI feeding a live vault. So: (H0) push, gate, fix the safety inversions, and amend the PRD so delivered P1 work is official and dead P0 scope is formally cut; (H1) close the amended §13 by routing every remaining P0 gap through the strongest existing subsystem (mount the existing InboundCard, reuse context_pack's queue-item assembly for packets, project exports through the existing markdownProjection, wire chrome.sessions into the existing strategy enum); (H2) make the vault survive years (compaction, event-store default, durability, perf harness); (H3) pay down boundaries (contracts, monolith splits, compute lane) so agent-parallelized work stops triplicating shapes. New P1 feature work is frozen until the amended §13 walkthrough passes.


### Judge scores (winner: mvp-first)

- **mvp-first** — fit 9, risk 8, achievability 9, compounding 7. Best alignment with the PRD's own gate (PRD.md:1131 'If all 16 steps work, MVP ships'): days-scale H1 (push/CI/green baseline/F11+F12 data-loss/F04+F03+F30 privacy), weeks 1-3 safety inversion + §13 closure under a written P1 freeze, recorded demo as ship artifact, architecture backlog explicitly gated behind 16/16. Risk timing strong: F11/F12/F16 land in days — earlier than either rival; F01 lands weeks 1-3. Merge strategy (push now, targeted review, one audited merge, small PRs after) is the most realistic for a single dev vs leverage-reality's PR-slice stack. Weaknesses: durability is 'minimum-viable' (F25/F26/F27 wait until weeks 4-6, tripwires only), all storage work (F09/F10/F24) deferred past week 7, and contracts (F07) — the agent-parallelism multiplier — land last, capping compounding at 7. PRD reconciliation (F34) sits at the END of H2, meaning some §13 UI gets built days before its spec is amended.
- **stability-first** — fit 6, risk 9, achievability 6, compounding 7. Strongest risk posture: F01/F02/F03/F04/F11/F12 all inside weeks 1-5, full durability program (F25/F26/F27/F28), perf-lane-gates-storage ordering (F17 before F10 flip), crash-consistency suite and archive-before-tombstone rules — the most complete treatment of the 'live rig is the product' reality. But requirementsFit fails the PRD's own priority: §13 closure — days-scale UI work per F05 — is deferred to weeks 11-16 (mid-Sept→late Oct), and its own risks section concedes that invisible durability work against the documented single-dev drift pattern is the plan's failure mode. 16 weeks of L-effort items before any visible MVP win is the least achievable sequencing for this operator profile. Compounding is real (perf lane, durability substrate) but contracts still land weeks 11-16 and the §15 window doesn't even start until Q4. Distinct grafts worth stealing: crash-consistency exit criterion, e2e scheduled-non-blocking until recorder fix, promote-branch-to-mainline escape hatch, --install-service as documented run mode, validate-synthetic-corpus-against-known-incident.
- **leverage-reality** — fit 9, risk 7, achievability 8, compounding 8. The most honest treatment of drift: full PRD amendment in H0 (bless delivered-early vector recall, rename §13 step 15, cut clipboard-fallback/typed-links to dated P2 homes, record §9-buffer supersession) BEFORE building — so H1 targets are true from day one. Best implementation leverage: every §13 gap routed through an existing subsystem (mount InboundCard, reuse context_pack queue assembly mcpServer.ts:364-375, export via markdownProjection, chrome.sessions into the existing enum) — this is why its H1 items are S/M where others estimate M. F01 lands earliest (H0 weeks 1-2). Weaknesses: F12 explicit-capture loss waits until H1 (weeks 3-6) and the green-baseline/runner fix (F15/F16) is the LAST H1 item — CI stood up in H0 gates against a red baseline for a month, which drops riskReduction to 7. The H0 PR-slice stack of 247 commits is the achievability wart mvp-first correctly calls 'weeks of work that closes zero §13 steps'. Compounding is the best of the three (amend-first + reuse + contracts-before-splits ordering in H3).

### Synthesized roadmap (recommended)

The §13 acceptance scenario (PRD.md:1078-1132) hard-fails at step 7 while ~63k LOC of post-MVP P1 systems compound on an unpushed 247-commit branch riding the live vault; the real distance to 'MVP ships' is days-scale UI/plumbing plus one ship-blocking safety inversion (redaction sanitizes the audit copy, not the outbound text — F01). Sequence, taking mvp-first's skeleton and grafting the rivals' best ideas: (H1, days) protect the work and the vault — push, CI, green baseline, the data-loss/privacy patches — AND land the full PRD reality amendment now (leverage-reality's amend-first: bless delivered-early work, cut dead scope to dated P2 homes, write the P1 freeze down) so every subsequent build target is honest; (H2, weeks 2-4) invert the safety chain and close the four broken §13 steps by routing each gap through the strongest existing subsystem (mount InboundCard, reuse context_pack's queue assembly, project exports through markdownProjection, wire chrome.sessions into the existing enum); (H3, weeks 5-7) one audited merge to main, the recorded 16-step demo as the ship gate, durability minimum with stability-first's crash-consistency suite, tripwires, and the supervised install, then formally start the 30-day §15 window; (H4, weeks 8+, gated on 16/16) the architecture backlog in dependency order — perf lane first because it gates the storage program, contracts before decompositions, strangler-only on the monoliths. Architectural work is admitted early only where it blocks a §13 step or can lose data during dogfood.

### Now — protect the work, the vault, and the truth — days 1–5

- **[M] Push today; minimal CI; verify origin/main and record the merge strategy** (addresses F14)
  origin/feat/recall-ranker-v2-replacement holds all ~247 commits within 24h (minutes of work; do it first). GitHub Actions runs per-package lint+typecheck+unit on every push for all three packages; scripts/verify-standards.sh graduates from the starter template (AGENTS.md:96) and is invoked by CI; the flaky e2e lane runs scheduled and non-blocking until the recorder SW-attach fix lands (never train the developer to ignore red); the design-spec file referenced from /Users/yingfei/Downloads (spec-coverage.spec.ts:2) is vendored so CI is self-contained. Verify origin/main's actual state (last fetch 2026-05-28) and record the merge strategy in the decisions log now: default = one audited merge (H3), escape hatch = promote-branch-to-mainline if main proves unmergeable.
- **[M] One authoritative runner per package; baseline to green** (addresses F15, F16)
  Companion package.json `test` runs bun-native so the SQLite persistence suites (sqlite-store.test.ts:16, eventStore, engagement/timeline facts) execute instead of skipping — the current.json↔current.db byte-equivalence contract is enforced again. The 13-fail/8-file extension baseline is triaged: each file fixed or explicitly .skip'd with a tracking issue (each treated as potentially real until shown otherwise — a genuine capture-path bug pulls F12 work forward). Dead vitest coverage-threshold config deleted or enforced. Root verify green and CI-enforced; from here on, red means regression.
- **[M] Event-log and capture-outbox data-loss fixes, with crash tests** (addresses F11, F12, PRD§15-zero-data-loss, PRD§9)
  Boot-time replica-seq reconciliation: highWaterMark = max(seq file, max readShardTailSeq over own shards) (replicaId.ts:49-132; the helper at eventLog.ts:441-450 already exists, just never called at boot), closing the permanent dot-reuse poison path. Extension outbox: all queue mutations serialized through one promise-chain mutex; end-of-drain whole-queue rewrite (outbox.ts:290-292) replaced with per-item remove-by-id; eviction made two-key write-then-swap (queue.ts:178-184). Regression tests kill the SW mid-drain and mid-eviction and regress the replica-seq file — zero explicit-capture loss in each (stability-first's crash-test discipline, applied day one).
- **[S] Default-closed quick wins batch** (addresses F04, F03, F30, F29, 6.1.13c)
  createWorkstream defaults privacy to 'private' (writer.ts:839, projection.ts:45, extension create paths) per PRD.md:396. MCP streamable-http refuses to start keyless, gains a Host-header loopback check and timingSafeEqual (streamableHttpServer.ts:94-158). Companion: debug routes authRequired, origin/host gates before route match, SIDETRACK_HTTP_LOG logs pathname only at 0600 (server.ts:647-650, 7798-7890). VaultUnavailableError as a typed class replacing the string-compare at server.ts:7919. All S-sized, parallelizable across agents in the first PR wave.
- **[M] P1 freeze in writing + full PRD reality amendment + ROADMAP truth pass — amend before building** (addresses F06, F34, F32, F33, F29)
  Leverage-reality's H0 graft, pulled ahead of all H2 UI work so build targets are honest before anything is built. Dated decisions-log entries: (a) FREEZE — no new ranker/recall/connections/attribution scope until all 16 §13 steps pass, live loops in maintenance mode only; (b) DELIVERED EARLY — hybrid /v2 vector recall (§6.1.8 superseded), persistent annotation anchoring, suggestion layer; (c) RENAMED — §13 step 15 → sidetrack.* / streamable-HTTP :8721; (d) BLESSED — 3-state queue lifecycle, JSONL reviews, body-section checklist; (e) CUT to dated P2 homes — clipboard-capture fallback, typed links + link_items (the connections graph is the interim link substrate), §9 in-memory buffer (superseded by the outbox); (f) MCP allow-by-default trust either reverted to opt-in or signed as a deviation. 4-5 retroactive ADRs (SQLite substrates, IVM-only, ranker serving policy, setup-sqlite import order). ROADMAP.md updated from 'M1 building' to reality with open P0 gaps as the active milestone. Every amendment passes an adversarial 'decision or surrender?' check.

### Next — invert the safety chain, close the broken §13 steps through existing subsystems — weeks 2–4

- **[M] One outbound preflight for every dispatch path; token budget surfaced** (addresses F01, F31, 6.1.13a, 6.1.13b, 6.1.13d, §13-step11, §13-step16)
  Contract test lands FIRST, enumerating dispatch paths. Then: POST /v1/dispatches returns the redacted body; clipboard copy (App.tsx:4047/4055/4126), auto-send/redispatch (background.ts:3411→autoSendOnceTabReady:1847), and selection paths all route through a single preflight enforcing redaction + scanForInjection + screenShareSafeMode + token gate; auto-link matcher reconciled against redacted text; AWS-key/SSN/phone categories added (redaction.ts:13-45). cacheDispatchOriginal (messages.ts:73-78) is removed only after the redacted-clipboard path has dogfooded ≥1 week behind a flag (stability-first's mitigation — this changes daily-driver paste UX). The companion's real cl100k warning (server.ts:4589-4591, currently discarded) renders in DispatchConfirm/RecentDispatches with per-provider context-window thresholds replacing the hardcoded 8000 (tokenBudget.ts:7). The ship-blocker inversion — sanitized audit copy, raw text to providers — is closed and pinned by an automated test.
- **[M] Workboard completion: checklist UI + live Inbound and Queued views** (addresses F05, 6.1.1, 6.1.5, 6.1.6, §13-step3, §13-step7, §13-step9)
  viewMode union (App.tsx:779-781) gains 'inbound' and 'queued'; the already-built InboundCard.tsx graduates from entrypoints/preview to the live panel ('ChatGPT replied 2 minutes ago' rows); checklist add/tick/remove UI lands on the workstream detail — the entire data path (events.ts:31 → markdownProjection.ts:106-112 → client.ts:183) already works, this is pure App.tsx rendering. §13 steps 3, 7, 9 pass. Well-specified parallel agent work: backend contracts already fixed.
- **[M] Queue→packet handoff + export-to-tree route via existing assemblies** (addresses F05, 6.1.4, 6.1.9, 6.1.11, 6.2.3, §13-step11, §13-step13)
  PacketComposer gains queue-item selection whose data comes from the same companion assembly MCP context_pack already uses (mcpServer.ts:364-375) — no new extension-side aggregation; selected asks render as the Research Packet questions section (the napkin's core loop). New export route projects packet/thread markdown to <Project>/<Sub>/.../<name>-<reportN>.md via the existing markdownProjection renderer and workstream tree, replacing flat _BAC/<type>/<bac_id>.md (writer.ts:757, 845-848) as the user-facing export; 'Export to vault' button in the panel. §13 steps 11 and 13 pass.
- **[S] Tab recovery + tracking residuals** (addresses F33, 6.1.7, 6.1.2a, §13-step8)
  chrome.sessions.getRecentlyClosed backs the existing-but-unreachable 'restore_session' branch (TabRecovery.tsx:3-8, App.tsx:543-545) — small, the enum and UI already exist; a really-closed tab restores with session state, satisfying §13 step 8 and the §15 recovery criterion. Per-site tracking toggle added beside the global autoTrack boolean, or formally deferred per the H1 amendment if it threatens the sprint.
- **[M] MCP trust from server-derived identity; complete the audit schema; add new_cluster** (addresses F02, F32, 6.1.14, §13-step15)
  Caller identity derived server-side (per-client/MCP-scoped keys), trust enforced on identity — dropping the x-sidetrack-mcp-tool header (server.ts:6361-6364) no longer bypasses the gate, with a test proving it; a deprecation window logs both paths before the old one hard-fails (existing agent integrations rely on the voluntary header). auditEventSchema gains agent/tool/args/trustMode (schemas.ts:355-361) so MCP writes are attributable and the bypass is detectable. sidetrack.workstreams.create (new_cluster) registered; link_items stays formally deferred per H1. §13 step 15 becomes passable under the amended naming.

### Then — merge, run the honest demo, durability minimum, start the 30-day window — weeks 5–7

- **[M] One audited merge to main; small-PR regime from then on** (addresses F14)
  After CI is green and targeted code-review passes on the high-risk subsystems (safety chain, vault writes, outbox, event log), the branch merges to main as one audited merge — not a retroactive 40-PR stack. Rollback path: previous dogfood ref pinned before merging. main becomes the dogfood-deployed ref; every subsequent change is a small CI-gated PR (no branch unmerged >1 week). If the H1 verification found main unmergeable, the recorded promote-branch-to-mainline decision executes instead.
- **[M] Scripted, recorded §13 acceptance run — the ship gate** (addresses F05, F34, PRD§13-all-16-steps)
  The full 16-step scenario executed in one recorded session on the live dogfood setup; each step passes as written or against a dated decisions-log amendment from H1; every failure filed and fixed until a clean run exists. 'If all 16 steps work, MVP ships' (PRD.md:1131) becomes a checked artifact.
- **[M] Synthetic-vault e2e covering the demo spine; recorder fix; harness validated against a known incident** (addresses F14, F17, PRD§13)
  An e2e project running capture→organize→checklist→queue→packet→dispatch→export against a synthetic vault, scheduled in CI (never the live vault); the recorder-lane SW-attach fix applied; the SW-never-appeared flake budgeted and stabilized inside this item. The harness must reproduce at least one known past incident shape (e.g. the resolve-flood pattern) before its green is trusted — the 6-item-fixture-hid-leiden lesson codified. The §13 demo becomes repeatable regression coverage.
- **[M] Durability minimum + supervised install + crash-consistency suite** (addresses F25, F20, F27, PRD§15-7-day-durability)
  writeProjection/writeJson/markdown sidecars routed through writeFileAtomic; torn existing docs treated as absent-with-audit-entry instead of wedging the aggregate (writer.ts:222-229); legacy capture lane deduped by an idempotencyKey-derived stable id so >1h replays stop minting divergent duplicates (idempotency.ts:24). uncaughtException/unhandledRejection handlers with structured post-mortem + clean exit for the sole vault writer; --install-service (already implemented, launchd.ts:34) becomes the documented dogfood run mode with KeepAlive respawn, replacing screen sessions. Crash-consistency suite green: kill -9 mid-append, torn-JSON boot, replica-seq regression. Full fsync posture and lane-merge documented as accepted deferrals — scoped strictly to data-loss risk.
- **[M] Data-loss tripwires + honest health edges + full-rebuild alarm** (addresses F26, F28, F23, PRD§15-zero-data-loss)
  Skipped/malformed-line counters per shard, store-vs-JSONL count reconciliation, dot-collision and duplicate-capture detectors surfaced in /v1/system/health; the materializer's full-rebuild fallback (connectionsMaterializer.ts:3821-4010) gets an alarmed counter + drain budget so the next unanticipated event mix is visible, not a silent 16-18s stall. service.running queried from launchctl/systemctl instead of plist existence; learnedRerank refresh failures and MCP-child liveness get health sections with lastError. Zero-data-loss over the window becomes falsifiable.
- **[S] §15 instrumentation; formally start the 30-day window** (addresses PRD§15, F28)
  Counters visible in the health panel for: Research Packets actually dispatched, tab recoveries via the recovery surface, MCP context-pack coding sessions, tracked-vs-untracked AI work share, reorganizations. The 30-day dogfood clock (PRD.md:1150-1168) starts against measured criteria, on the supervised install.

### Later — post-demo unfreeze: the architecture backlog in dependency order — weeks 8+, only after all 16 §13 steps pass

- **[L] Perf/scale regression lane FIRST — it gates the storage program** (addresses F17)
  A replayed event corpus at real scale (≥600k events, seeded from an anonymized clone of the live log, never the live vault) asserting drain-time and hot-route latency budgets plus an RSS ceiling; runs nightly in CI; validated by reproducing a known past incident before its green gates anything. Every prior perf cliff (45s /status, resolve floods, 46-69s appends) shipped to the live vault first — this lane is the explicit precondition for the storage program below (stability-first's ordering).
- **[XL] Storage lifetime program: rollup, compaction, store-ON default, migrations + WAL hygiene** (addresses F09, F10, F24, F26)
  In order, each gated on the perf lane and preceded by a vault snapshot: engagement-interval rollup + log compaction (93% of daily bytes is telemetry) with archive-before-tombstone as a hard rule and a rebuild-from-truth test; SQL aggregation projections replacing readMerged folds for serving routes; per-shard applied dot-interval tracking (fixing the eventStore.ts:355 out-of-order permanent skip) + reconciliation counters as the flip precondition; then SIDETRACK_EVENT_STORE defaults ON and readMerged retires as serving fallback; SQLite user_version migrations across the five stores + wal_checkpoint(TRUNCATE) on idle/drain hooks + WAL gauges in health.
- **[L] Boundary contracts: shared schemas, generated docs, writer→reader round-trip** (addresses F07)
  Shared zod schema package (or OpenAPI generated from schemas.ts with generated clients) replacing hand-triplicated shapes and as-casts (client.ts:64-163, messages.ts:542); MCP tool docs regenerated from registered capabilities (killing the dead bac.* docs); one companion-writer→LiveVaultReader round-trip test pinning the vault file format; coverage check in scripts/verify-standards.sh. Lands before the decompositions below — it is the agent-parallelism multiplier and the pin the splits extract against.
- **[XL] Compute lane + serve-path efficiency + strangler server decomposition** (addresses F13, F22, F08)
  The embedder-sidecar pattern (embedder.ts:307-317) generalized into one off-main-loop compute lane serving resolve builds, cross-encoder rerank, learned-rerank feature builds, and backfills (unblocks the parked doc-vector gate); typed incremental folds + per-type log sub-signatures (recall.served appends stop busting unrelated caches, server.ts:2337-2380) + pre-handler 304 validators; per-resource route modules extracted strangler-style as routes are touched — no big-bang rewrite — with caches moved to an injected per-vault registry and ConnectionsStore capability methods replacing the 12 instanceof branches.
- **[L] Extension boundary paydown: typed handler registry + single SW transport** (addresses F18, F19)
  background.ts 74-message if-chain replaced by a typed handler registry keyed by messageTypes; capture gates / companion-identity pinning / privacy extracted into tested src/background/ modules; five hand-rolled transports collapsed to one SW-resident client; annotation path SW-proxy-only so the bridge key leaves content-script world on provider pages (annotation/client.ts:109).
- **[L] Connections hygiene: dead lanes deleted, flag registry, honest tests** (addresses F21, F35)
  Hard-disabled hot-similarity lane and rejected facts-store lanes deleted; the lying 'ON by default' comment (hotPathMode.ts:1-24) corrected; topic shadow A/B time-boxed with a removal date; central SIDETRACK_* flags module (name/default/status/owner/retire-by, 86 flags today) with a generated docs table and dead flags removed in the same pass; the vacuous HNSW-vs-pairwise equivalence test rewritten against an injected legacy implementation or honestly deleted. The XL materializer split stays strangler-only, not a dedicated project.


### Do-nots

- Don't start any new ranker/recall/connections/attribution scope — including 'one more retrain improvement' — until all 16 §13 steps pass; live loops run in maintenance mode only. 43 of 62 visible unmerged commits went to P1 systems while the demo hard-fails at step 7; the written freeze (H1) is the load-bearing decision.
- Don't retroactively slice the 247 commits into a reviewable PR stack — push as-is today, run targeted reviews on safety/vault-write/outbox/event-log code, merge once as an audited merge with a pinned rollback ref. If origin/main proves unmergeable, execute the recorded promote-branch-to-mainline decision instead of pretending a 343-file review will happen.
- Don't run test suites, benchmarks, or replay harnesses against the live dogfood vault or ports 17373/17374/9222 — synthetic vaults and an anonymized-clone corpus only.
- Don't flip the SIDETRACK_EVENT_STORE default, build compaction, or tombstone anything during the demo/30-day window — tripwires only in H3; storage surgery waits for H4, behind the perf lane, with a vault snapshot before every landing and archive-before-tombstone as a hard rule.
- Don't silently edit the PRD to match the code — every divergence goes through a dated decisions-log entry with rationale, every cut gets an explicit P2 home, and each amendment passes an adversarial 'decision or surrender?' check so 'delivered early' and 'quietly abandoned' stay distinguishable.
- Don't build typed links/link_items, the clipboard-capture fallback, the §9 in-memory buffer, or the 5-state queue lifecycle without a recorded build-vs-defer decision — the default is the formal P2 defer landed in H1.
- Don't delete cacheDispatchOriginal or ship the redacted-clipboard path unflagged until it has dogfooded ≥1 week — it changes the daily-driver paste UX and the auto-link matcher in one move.
- Don't let the flaky e2e lane gate merges until the recorder SW-attach fix lands — scheduled non-blocking only; a red gate the developer learns to ignore is worse than no gate.
- Don't start the large refactors (server.ts decomposition, materializer split, shared contract package, compute lane, SW registry) inside the MVP window — none blocks a §13 step; afterward, strangler-style only.
- Don't resurrect adjudicated decisions — the Phase-4 visual search refactor hold (2026-05-19) and the memory-floor 'measure, don't implement' conclusion stand; and don't add new SIDETRACK_* flags without a registry entry once F35 lands, especially none whose absence means ON.

### Exit criteria

- A recorded end-to-end run of all 16 PRD §13 steps on the live dogfood setup exists; every step passes as written or against a dated H1 decisions-log amendment; zero steps skipped or hand-waved.
- origin holds every commit within 48h of authorship; CI (per-package lint+typecheck+unit, all three packages) is green on every push; companion SQLite suites execute (not skip) under the declared runner; extension unit baseline has 0 unexplained failures.
- An automated contract test proves no outbound path — clipboard copy, auto-send, redispatch, selection, packet render — can ship un-redacted or un-scrubbed text; any raw-body escape fails the build; §13 step 11 demonstrates redaction firing on the pasted text, not just the stored copy.
- New workstreams default to privacy 'private'; the MCP http transport refuses to start keyless; every MCP write is attributed in the audit ledger with agent/tool/args/trustMode; a test proves the header-drop trust bypass is closed.
- Crash-consistency suite green and staying green: kill -9 mid-append, SW-kill mid-drain and mid-eviction, torn-JSON boot, replica-seq regression — zero acknowledged-event loss in each; plus 7 consecutive dogfood days with zero data-loss signals on the health tripwires (no dot collisions, duplicate captures, torn aggregates, dropped explicit captures, or skipped-line growth).
- §15 counters are live and met during the 30-day window on the supervised install: ≥80% AI work tracked, ≥3 lossless reorganizations, ≥5 Research Packets actually dispatched, ≥1 tab recovered via chrome.sessions, ≥1 MCP context-pack coding session, ≥7 days continuous zero-data-loss operation — at which point MVP is declared and the P1 freeze lifts.
- The branch is merged to main and all subsequent work lands as small CI-gated PRs (no branch unmerged >1 week); zero unrecorded code-vs-doc divergences remain (PRD decisions log, ADRs, and ROADMAP all current).

### Risks

- Freeze discipline is the whole plan: a single developer whose branch history shows sustained gravitation to P1 systems must hold a self-imposed freeze; defenses are the written H1 decision, required-green CI, and front-loading agent-parallelizable S/M items — if week 3 slips into recall tuning, the roadmap has already failed.
- F01 changes user-visible dispatch text daily: the auto-link matcher, review-span offsets, and paste UX can regress together; the contract test lands first, the redacted path dogfoods behind a flag, and rule-category additions are cut before path coverage if the item grows past M.
- The audited merge to main can destabilize the live dogfood companion mid-window; mitigations are H1 CI + green baseline landing first and a pinned rollback ref — and origin/main's state is unverified since 2026-05-28, so the promote-to-mainline escape hatch may need invoking early.
- H2 UI/safety changes reach the live vault before the synthetic e2e lane exists (H3) — inherent exposure from the sequencing; keep H2 behind the new unit/contract tests and small commits.
- The e2e harness itself is flaky (SW-never-appeared-after-45s, broken recorder lane); the scripted demo may be blocked by harness noise rather than product gaps — harness stabilization is budgeted inside the H3 e2e item and must not leak into H2.
- The 13-fail extension baseline may be masking real regressions; H1 triage treats each failure as potentially real, is blocking for H2 UI work in the same components, and a genuine capture-path bug there pulls F12-adjacent work forward.
- PRD amendments can become scope-laundering; the adversarial pass and mandatory P2 homes are the guard — without them the 'honest demo' exit criterion is hollow.
- Durability posture through the 30-day window is still minimum-viable: no fsync anywhere means OS-crash/power-loss can lose acknowledged events; this is a documented accepted risk, and a power-loss incident during the window would fail §15 despite plan adherence.
- The synthetic perf corpus may not reproduce live pathologies (the 6-item fixture hid a 6.8s leiden rebuild at N=896); it must be seeded from an anonymized clone and reproduce at least one known incident before its green gates the storage program.
- Storage grows ~9-10MB/day until H4 compaction (~bounded, several hundred MB over the plan); if drain latency degrades dogfood earlier than expected, pull the engagement rollup forward ahead of the rest of H4.

---

## 4. Documentation amendments required (PRD / ROADMAP / ADRs)

- PRD.md §13 step 15 (lines 1124-1126): rewrite 'npx bac-mcp --vault <path>' and 'bac.context_pack({ workstream: "MVP PRD" })' to the shipped surface — sidetrack-mcp with sidetrack.workstreams.context_pack over stdio or streamable-HTTP :8721 — via a dated decisions-log entry in §11; as written the step can never pass.
- PRD.md §6.2.6: amend the long-lived local transport from raw WebSocket to MCP streamable-HTTP on :8721 with auth required (per the F03 fix); record as a dated decision, not a silent edit.
- PRD.md §6.1.8: amend 'MVP ships lexical only; vector is a follow-up' to record hybrid lexical+vector /v2 recall as DELIVERED EARLY (P1 §6.3.1 pulled forward), with the P1 freeze note that no further recall/ranker scope lands until §13 passes.
- PRD.md §6.1.4: bless the shipped 3-state queue lifecycle (pending/done/dismissed) replacing pending→ready→sent/done/skipped, OR explicitly schedule the 5-state build — default is bless, recorded with rationale; note that compose-packet-from-queue (H2 item) satisfies the queue→packet requirement regardless of lifecycle.
- PRD.md §6.1.6: bless checklist persistence as a '## Checklist' markdown body section (markdownProjection.ts:106-112) instead of the 'bac:checklist:' frontmatter array — still Obsidian-editable, which was the requirement's intent.
- PRD.md §6.1.10: bless ReviewEvent storage as _BAC/reviews/<date>.jsonl (writer.ts:669-675) instead of frontmatter arrays on captured-turn notes.
- PRD.md §6.1.2b: demote the clipboard-capture selector fallback to P2 with a dated disposition — canary detection + provenance shipped, and a single dogfooding dev detects selector breakage same-day; keep the warn behavior as the P0 remainder.
- PRD.md §6.1.3 + §6.1.14: move typed user links (related/source_of/follow_up/coding_session_for/dispatched_to) and the link_items MCP tool to P2 with a dated entry recording the connections graph (15.9k derived edges) as the interim link substrate; update the §6.1.14 tool list to 4-of-5 (move_item, new_cluster, queue_item, attach_coding_session) with link_items deferred.
- PRD.md §9 (line ~945): mark the companion in-memory write buffer (cap 100) as SUPERSEDED by the extension capture outbox; in the same section, document the actual durability posture explicitly (no fsync; crash-window semantics; what §15 'zero data loss' is falsifiable against via the H3 tripwires).
- PRD.md §6.1.14: record the allow-by-default workstream-trust flip (workstreamTrust.ts:65-77) as either reverted to PRD opt-in or a signed-off deviation with a first-run opt-in prompt — decided in H1, enforced by the H2 identity rework.
- PRD.md §6.2.3: record the per-workstream auto-download toggle and tier defaults (off-for-Inbox/on-for-project) as a P1 follow-up; promote-time vault write satisfies the P0.5 core; export naming now routes through the §6.1.11 tree-path route built in H2.
- docs/milestones/ROADMAP.md milestone table (lines 17-22): M1 → shipped (not 'building', PR #13 is long-superseded); M2 → shipped (dispatch + §24.10 safety chain + review live, modulo the F01 inversion being fixed in H2); M3 → substantially delivered early on feat/recall-ranker-v2-replacement (vector recall, learned ranker, connections/suggestion layer, persistent annotation — notebook link-back still open); insert a new active milestone 'M-MVP-closure' enumerating the open P0 gaps (checklist UI, Inbound/Queued views, queue→packet, export route, chrome.sessions, safety inversion, MCP identity/audit) with the §13 recorded run as its exit; M4+ unchanged, explicitly gated on the 30-day §15 window.
- docs/adr/: add retroactive ADRs 0006-0010 — (0006) SQLite substrates: event-store mirror, SqliteConnectionsStore as default, sqlite-vec recall-v2 store; (0007) IVM-only materializer with opt-out removal; (0008) learned-ranker serving policy and serve gates; (0009) setup-sqlite import-order invariant (setCustomSQLite before any DB open); (0010) MCP streamable-HTTP transport + sidetrack.* namespace rename.
- PRD.md §11 decisions log: add the dated P1-freeze entry itself ('no new ranker/recall/connections/attribution scope until all 16 §13 steps pass; live loops maintenance-only') so it binds coding agents per the CLAUDE.md override hierarchy, plus the merge-strategy decision (single audited merge, promote-to-mainline escape hatch).
- PRD.md §6.1.12 (minor): record that bac_ids are 16-char random Crockford-base32, not timestamp-prefixed ULIDs — functionally equivalent for the identity invariant; prevents a future 'fix' churning IDs.
