# M1 — Agent handoff prompt

This file is the paste-ready prompt for the coding agent that will
build M1. Designed to be self-contained: the agent reads this prompt,
reads the references it points at, and starts implementing without
needing the conversation history that produced it.

> Pasting tip: include a one-liner pointing the agent at this repo
> path (`/Users/yingfei/Documents/playground/browser-ai-companion`)
> when you hand it over. The prompt assumes the agent can read files
> there.

---

## Prompt

```
You're picking up the first production milestone (M1 — Foundation) for the
Sidetrack project at /Users/yingfei/Documents/playground/browser-ai-companion.
You take charge of branch `m1/foundation` (already created off main; this
prompt and the milestone scope live there at
docs/milestones/M1-foundation/). Final landings can target either feature
branches off m1/foundation (one per sequencing step) or commits directly on
m1/foundation — your call based on review preferences. Don't push to main.

# Required reading (do not skip — ~2 hours)

In this order, before writing any code:

1. AGENTS.md (5 min) — repo conventions; this is the override surface.
2. PRD.md §1, §3, §5, §6.1.1, §6.1.2 (15 min) — what we're building.
3. docs/adr/0001-companion-install-http-loopback.md (5 min) — companion
   install path is HTTP loopback. Locked. Do not revisit.
4. BRAINSTORM.md §23.0, §24.5, §27, §27.6 (10 min) — load-bearing
   anchors. Use BRAINSTORM-INDEX.md to navigate.
5. CODING_STANDARDS.md (10 min) — non-negotiables. Especially the
   POC-to-product conversion rule (don't blindly promote PoC code).
6. standards/03-ts-browser-plugin.md (15 min) — extension standards.
7. standards/02-mcp-components.md (10 min) — MCP read-side standards.
8. poc/local-bridge/README.md + skim companion/ + extension/ source
   (20 min) — what's been proven; what to lift.
9. poc/provider-capture/README.md + skim source (15 min) — capture
   pattern to lift (focus on ChatGPT extractor).
10. poc/mcp-server/README.md (10 min) — read side as-is.
11. design/MVP-mocks-prompts.md Mock 1 only (5 min) — Workboard
    layout for the side panel.
12. design/mockup-stage/REVIEW.md (5 min).
13. Open design/mockup-stage/project/SwitchBoard.html in a browser
    (15 min) — see the design language live; copy color tokens, fonts,
    rhythm.

If anything contradicts after reading: AGENTS.md and BRAINSTORM
anchors win. CODING_STANDARDS.md wins for code-quality questions.

# What to build

Read docs/milestones/M1-foundation/README.md for the full scope.
Summary: production-grade scaffolds for `packages/sidetrack-companion/`
and `packages/sidetrack-extension/`, plus the smallest possible vertical
slice (one provider's capture → companion vault write → bac-mcp returns
the thread). Sequencing in the README has 11 numbered steps; each is
independently reviewable.

# What to NOT build (frequent agent over-reach)

- No workstream tree organization (Mock 2 — that's M2).
- No queues, packets, dispatches, reviews, settings beyond minimum.
- No first-run wizard (programmatic config / paste bridge.key for M1).
- No tab recovery, manual checklist, inbound reminders.
- No §24.10 safety primitives (no dispatch surface in M1, so they're
  not load-bearing yet — M2/M3).
- No MCP write tools or per-workstream trust mode (M2+).
- No MCP host role.
- No vault Markdown projection / canvas / bases (M2).
- One provider only — ChatGPT preferred. Adding others is mechanical
  and is M1.5/M2.

The M1 README has a full out-of-scope FAQ at the bottom for the
"should I build X?" questions agents commonly ask. Re-read it before
opening scope.

# Naming

Product name is **Sidetrack** (locked per ADR/PR #11). Existing
`_BAC/` namespace is preserved as a stable vault convention — do not
rename it to `_SIDETRACK/`. Workstream-tree examples in design docs
use "Switchboard / MVP PRD" — that's the user's example workstream
name, not a product reference; preserve as-is.

# E2E acceptance — the bar to pass

The milestone ships when ALL of these pass (full criteria in
docs/milestones/M1-foundation/README.md §"E2E acceptance criteria"):

1. `npx @sidetrack/companion --vault /tmp/sidetrack-m1` boots cleanly,
   binds 127.0.0.1, writes `_BAC/.config/bridge.key`.
2. Extension installs from `packages/sidetrack-extension/.output/
   chrome-mv3`, paste-key first-run flow connects.
3. Open chat.openai.com, send a message, get a turn → JSONL line
   appears in `/tmp/sidetrack-m1/_BAC/events/<date>.jsonl` within 30s
   with `provider: "chatgpt"`, `threadId`, `threadUrl`, `capturedAt`.
4. Side-panel Current Tab section shows the thread; Recent section
   lists it.
5. `npx bac-mcp --vault /tmp/sidetrack-m1` boots, `bac.recent_threads`
   returns the thread within 5s.
6. Chrome restart: side panel reconnects, Recent persists, capture
   continues.
7. Companion crash + restart: extension queue replays cleanly.
8. Standards gates green: `lint && typecheck && test && build && e2e`
   in both packages.
9. No `any` across boundaries; no hidden global state.
10. Failure-mode banners surface per PRD §9 (companion-down,
    vault-unreachable, provider-broken).

# Constraints

- Do NOT push to main.
- Do NOT modify the PoCs under `poc/*` — they're reference / behavior
  evidence. Lift behavior, capture as tests, then implement to
  standards in `packages/`.
- Do NOT modify BRAINSTORM.md, PRD.md, AGENTS.md, ADRs, or the
  standards kit. If you find an actual error in any of those, file a
  separate fix PR; don't bundle it with M1 work.
- Do NOT add features outside the scope above. If you discover a real
  need for an out-of-scope feature, document it in
  docs/milestones/M1-foundation/SURPRISES.md and continue.
- Default to per-step commits with clear messages. PRs per step are
  encouraged for review velocity.
- Make reasonable defaults without asking; record each choice in the
  step's commit message.

# Done

When the E2E acceptance + standards gates pass:
- Write docs/milestones/M1-foundation/DEMO.md (copy-paste runbook
  from install through MCP query, including Chrome-restart and
  companion-crash variants).
- Write docs/milestones/M1-foundation/STANDARDS-CHECK.md (filled
  checklists from `checklists/`).
- Update docs/milestones/M1-foundation/README.md status from
  "planning" to "complete" with a brief retrospective note (what
  surprised you, what's the obvious M2 candidate based on what you
  observed during the build).
- Open the final PR titled "M1: Foundation — production scaffolds +
  vertical slice" against main.

Time-box: if any single sequencing step (1–10 in the README) has
taken more than 3 calendar days, stop and flag what's stuck — don't
silently push past the budget.

Start now.
```

---

## Notes for the human handing this off

- The agent should land per-step commits (not one giant final commit). Reviewers can sample step boundaries instead of staring at a 50-file PR.
- Step 1 + Step 2 (scaffolds) deliberately have zero business logic — they're a forcing function to get standards/configs/CI right before any feature work goes in.
- Step 7 (design tokens applied) is intentionally separate from step 5 (functional plumbing) because design polish is its own review unit.
- The agent will likely want to extract shared types/utilities into `packages/sidetrack-shared/`. That's fine — encourage it. Just keep the package count modest (companion / extension / shared / mcp-reuse-from-poc).
- If the agent finishes M1 in <1 week, scope was probably too small; if >2 weeks, scope was probably too big or quality is being sacrificed.
- The Codex companion already exists; alternative agent options include Claude Code, Cursor, Codex CLI. The prompt is agent-neutral.
