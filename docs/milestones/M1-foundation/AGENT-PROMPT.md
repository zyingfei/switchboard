# M1 — Agent handoff prompt

This file is the paste-ready prompt for the coding agent that will
build M1 (Foundation — Tracker). Designed to be self-contained: the
agent reads this prompt, reads the references it points at, and
starts implementing without needing the conversation history that
produced it.

> Pasting tip: include a one-liner pointing the agent at this repo
> path (`/Users/yingfei/Documents/playground/browser-ai-companion`)
> when you hand it over. The prompt assumes the agent can read files
> there.

---

## Prompt

```
You're picking up the first production milestone (M1 — Foundation /
Tracker) for the Sidetrack project at
/Users/yingfei/Documents/playground/browser-ai-companion. You take
charge of branch `m1/foundation` (already created off main; this prompt
and the milestone scope live there at docs/milestones/M1-foundation/).
Final landings can target either feature branches off m1/foundation
(one per sequencing step) or commits directly on m1/foundation — your
call based on review preferences. Don't push to main.

# Required reading (~3.5 hours, do not skip)

In this order, before writing any code:

1.  AGENTS.md (5 min) — repo conventions; this is the override surface.
2.  PRD.md §1, §3, §5, §6.1.1 through §6.1.13, §9 (30 min) — the full
    P0 tracker surface this milestone implements.
3.  docs/adr/0001-companion-install-http-loopback.md (5 min) —
    companion install path is HTTP loopback. Locked. Do not revisit.
4.  BRAINSTORM.md §23.0, §24.5, §27, §27.6 (10 min) — load-bearing
    anchors. Use BRAINSTORM-INDEX.md to navigate.
5.  CODING_STANDARDS.md (10 min) — non-negotiables. Especially the
    POC-to-product conversion rule (capture PoC behavior as tests;
    don't blindly promote).
6.  standards/00-engineering-baseline.md (10 min) — boundary
    validation, typed errors, observability, security.
7.  standards/01-api-component.md (15 min) — applies to companion
    HTTP surface. Skim `templates/api-endpoint-rfc.md`,
    `configs/openapi/openapi.base.yaml`,
    `configs/openapi/api-style-rules.yaml`. Sequencing step 4 lands
    the API RFC + OpenAPI before any route is implemented.
8.  standards/02-mcp-components.md (10 min) — MCP read-side standards.
9.  standards/03-ts-browser-plugin.md (15 min) — extension standards.
10. poc/local-bridge/README.md + skim companion/ + extension/ source
    (20 min) — what's been proven; what to lift.
11. poc/provider-capture/README.md + skim THREE provider extractors
    (chatgpt.ts, claude.ts, gemini.ts) plus the unknown.ts generic
    fallback (20 min) — capture pattern; M1 ships three, NOT codex
    (no PoC).
12. poc/mcp-server/README.md + skim source (15 min) — read side.
13. poc/dogfood-loop/README.md (15 min) — workstream graph entities
    (Workstream / Bucket / Source / PromptRun / ContextEdge); lift
    the data model (skip the fork/converge/dispatch parts — those
    are M2).
14. design/MVP-mocks-prompts.md Mocks 1, 2, 3, 4, 9, 10, 11, 13
    (15 min) — UI surface for M1.
15. design/mockup-stage/REVIEW.md + open
    design/mockup-stage/project/SwitchBoard.html in a browser
    (20 min) — design language live; copy color tokens, fonts, rhythm.
    NOT a pixel-perfect target per user direction; recreate in
    TS-strict React.

If anything contradicts after reading: AGENTS.md and BRAINSTORM
anchors win. CODING_STANDARDS.md wins for code-quality questions.

# What to build

Read docs/milestones/M1-foundation/README.md for the full scope. This
is the **tracker complete** milestone — full P0 surface for
tracking + organization + queue + inbound + tab recovery + read-side
MCP. The dispatch surface (packets, inline reviews, §24.10 safety
chain) is the M2 milestone.

Three packages land in this milestone:
- packages/sidetrack-companion/ — Node 22+, HTTP loopback, vault
  writer, audit log
- packages/sidetrack-extension/ — WXT + React + TS + MV3, side panel
  (full Mock 1), workstream organization (Mock 2/4), manual checklist,
  queue, inbound reminders, tab recovery, settings minimal,
  per-workstream privacy flag, all four provider captures
- packages/sidetrack-mcp/ — lift from poc/mcp-server, read-only,
  M1 tool surface (recent_threads, workstream, context_pack, search,
  queued_items, inbound_reminders)

The README has 21 numbered sequencing steps. Land per-step commits
or PRs (boundary at step 10 separates infrastructure — scaffolds +
API design + companion + capture — from user-facing UX from glue
from robustness). **Step 4 (API design RFC + OpenAPI) is a hard
gate**: no companion route is implemented before the RFC under
`packages/sidetrack-companion/docs/api/` and the OpenAPI spec under
`packages/sidetrack-companion/openapi.yaml` lint clean against
`configs/openapi/api-style-rules.yaml`.

# What to NOT build (frequent agent over-reach)

Defer to M2 — the dispatch milestone:
- Packet composer (Mock 5)
- Dispatch confirm + §24.10 safety chain (Mock 6) — Redaction,
  token-budget, screen-share-safe, captured-page injection scrub.
  These four travel together; don't start any without all.
- Inline review (Mock 7 / §28) — depends on dispatch.
- Recent Dispatches view (Mock 13 second half) — depends on
  DispatchEvent.
- MCP write tools + per-workstream trust mode (§6.1.14).
- MCP host role (§6.3.2).
- Annotation capture (Mock 14) — input side of §28.
- Coding session attach (Mock 12).
- First-run wizard polish (Mock 8 full version) — paste-key
  programmatic config is fine for M1.
- Auto-download (PRD §6.2.3) — depends on packet outputs.
- Vault Markdown projection (full Source notes / .canvas / .base) —
  M1 writes JSONL events + JSON index files. Markdown projection ships
  in M2 with promoted-artifact concept (depends on dispatch).
- Smart recall vector — lexical only in M1.
- Notebook link-back (PRD §10 Case B/C).
- Screen-share-safe auto-detect (per Q6 deferred to P1+) — the
  per-workstream privacy flag (P0) IS in M1 as the substantive
  control.

The M1 README has a full out-of-scope FAQ at the bottom. Re-read it
before opening scope.

# Naming

Product name is **Sidetrack** (locked per ADR/PR #11). Existing
`_BAC/` namespace is preserved as a stable vault convention — do not
rename to `_SIDETRACK/`. Workstream-tree examples in design docs use
"Switchboard / MVP PRD" — that's the user's example workstream name,
not a product reference; preserve as-is.

# E2E acceptance — the bar to pass

The milestone ships when ALL of these pass (full criteria in
docs/milestones/M1-foundation/README.md §"E2E acceptance criteria"):

Capture & tracking:
1. `npx @sidetrack/companion --vault /tmp/sidetrack-m1` boots
   cleanly, binds 127.0.0.1, writes `_BAC/.config/bridge.key`.
2. Extension installs from packages/sidetrack-extension/.output/
   chrome-mv3, paste-key first-run flow connects.
3. Open ChatGPT, Claude, Gemini → all three capture assistant turns
   within 30s into _BAC/events/<date>.jsonl. Plus: "Track current
   tab" on a non-AI URL (e.g. a GitHub PR) writes a generic-fallback
   thread record.
4. Selector canary works on each of the three providers; clipboard
   fallback functional.
5. Stop/remove tracking per-tab and per-site.

Organization:
6. Create nested workstream "Sidetrack / MVP PRD / Active Work".
7. Drag-move tracked items between workstreams; bac_id preserved.
8. Manual checklist with Add/tick/persist across reload.
9. Tags + per-workstream privacy flag; flagged workstreams render
   `[private]` in Workboard.

Queue:
10. Queue follow-up "Ask Claude to compare with VM live migration"
    appears in Workboard Queued + workstream detail. (No dispatch
    in M1 — list only.)

Inbound:
11. Send a Claude message, navigate away. When Claude replies, Inbound
    surfaces "Claude replied X min ago" with pulse-signal-orange.

Recovery:
12. Close a tracked tab → recovery dialog (focus open / restore
    session / reopen URL).

MCP read-side:
13. `npx @sidetrack/mcp --vault /tmp/sidetrack-m1`; bac.recent_threads
    returns 4 captured threads; bac.workstream returns nested tree;
    bac.context_pack returns Markdown; bac.search lexical works;
    bac.queued_items + bac.inbound_reminders return populated.

Failure modes:
14. Chrome restart → side panel reconnects, state persists.
15. Companion crash → queue holds; restart drains queue.
16. Vault unreachable → banner, re-pick, no data loss.

Standards:
17. companion: lint + typecheck + test + openapi-lint green.
18. extension: lint + typecheck + test + build + e2e green.
19. mcp: lint + typecheck + test green.
20. No `any` across boundaries; no hidden global state.
21. checklists/api-design-review.md, browser-plugin-design-review.md,
    mcp-design-review.md, production-readiness.md filled in
    STANDARDS-CHECK.md.

# Constraints

- Do NOT push to main.
- Do NOT modify the PoCs under poc/* — they're reference / behavior
  evidence. Lift behavior, capture as tests, then implement to
  standards in packages/.
- Do NOT modify BRAINSTORM.md, PRD.md, AGENTS.md, ADRs, or the
  standards kit. If you find a real error in any of those, file a
  separate fix PR; don't bundle with M1 work.
- Do NOT add features outside the scope above. If you discover a real
  need for an out-of-scope feature, document it in
  docs/milestones/M1-foundation/SURPRISES.md and continue.
- Default to per-step commits with clear messages. PRs per step are
  encouraged for review velocity.
- Make reasonable defaults without asking; record each choice in the
  step's commit message.

# Done

When E2E acceptance + standards gates pass:
- Write docs/milestones/M1-foundation/DEMO.md (copy-paste runbook
  covering install through MCP query, including Chrome-restart and
  companion-crash variants).
- Write docs/milestones/M1-foundation/STANDARDS-CHECK.md (filled
  checklists from checklists/).
- Update docs/milestones/M1-foundation/README.md status from
  "planning" to "complete" with a brief retrospective: what
  surprised you, what's the obvious M2 candidate based on what you
  observed during the build (expected: dispatch surface).
- Open the final PR titled "M1: Foundation (Tracker) — production
  scaffolds + full P0 tracker" against main.

Time-box: ~3-4 weeks total. If any single sequencing step (1-20 in
the README) has taken more than 4 calendar days, stop and flag what's
stuck — don't silently push past the budget.

Start now.
```

---

## Notes for the human handing this off

- The agent should land per-step commits (not one giant final commit). Reviewers can sample step boundaries.
- Step 1 + Step 2 + Step 3 (scaffolds) deliberately have zero business logic — forcing function to get standards/configs/CI right before any feature work.
- Step 9 (design tokens applied to Workboard) is intentionally separate from steps 4-8 (functional plumbing) because design polish is its own review unit.
- The agent will likely want to extract shared types/utilities into `packages/sidetrack-shared/`. Encourage it. Keep the package count modest (companion / extension / mcp / shared).
- M2 (dispatch milestone) scope is intentionally pre-named in the README and the prompt's DoD, so the agent's retrospective at the end frames "what's M2" with no ambiguity.
- The Codex companion already exists; alternative agent options include Claude Code, Cursor, Codex CLI. The prompt is agent-neutral.
- If the agent finishes M1 in <2 weeks, scope was probably too small or quality is sacrificed; if >5 weeks, scope was probably too big and should be split.
