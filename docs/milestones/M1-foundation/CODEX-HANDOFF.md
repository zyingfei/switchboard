# Codex handoff prompt — M1+M2 wiring + E2E validation

This file is the paste-ready prompt for the Codex agent that picks up
after Claude's M1+M2 UX-skeleton PR (#20) lands.

The skeletons are visual + structural; this handoff wires them to the
runtime and validates the automated provider path with Playwright's
bundled Chromium. Branded Google Chrome is reserved for the manual
Developer Mode acceptance pass.

---

## Prompt

```
You are picking up the M1 UX-skeleton wiring + manual E2E acceptance
pass for Sidetrack at /Users/yingfei/Documents/playground/browser-ai-companion.

You have:
- workspace-write sandbox for file edits
- the `computer-use` MCP server (SkyComputerUseClient) for driving
  real Chrome
- Yingfei is signed into ChatGPT, Claude, Gemini in their default
  Chrome profile

# Setup state

Branch: `ux/skeletons-m1-m2` (PR #20). Will be on `m1/foundation`
once merged, then on `main` once #13 + #20 merge.

PR #20 (Claude's UX skeletons) just landed:
- packages/sidetrack-extension/entrypoints/sidepanel/components/
  — 13 React components for M1 polish + M2 surfaces
- packages/sidetrack-extension/entrypoints/preview.html
  — Storybook-style preview entry mounting all components with stub data
- All components export prop interfaces; all gates green
  (lint + typecheck + 28/28 vitest + build)

PR #13 (M1 foundation, already on this branch) has:
- packages/sidetrack-companion (HTTP + Zod + Problem envelope + idempotency)
- packages/sidetrack-extension (App.tsx with Workboard + workstream tree
  + queue + privacy toggle + companion client + capture pipeline)
- packages/sidetrack-mcp (read-only stdio MCP)

# Your two missions

## Mission 1 — Wire the skeleton components into the live App

The components in `packages/sidetrack-extension/entrypoints/sidepanel/
components/` use stub data. Wire them into the existing background ↔
side-panel message bus + companion HTTP client so they render real
state.

For each component, the wiring pattern is:
1. Read the component's prop interface (TypeScript-strict)
2. Find the matching state in `src/workboard.ts` / `src/companion/
   model.ts` / `src/messages.ts`
3. Add a message type if needed (`packages/sidetrack-extension/src/
   messages.ts` is the canonical message bus)
4. Wire the handler in `entrypoints/background.ts` or directly in
   `entrypoints/sidepanel/App.tsx`
5. Replace stub onClick/onSubmit with real dispatchers
6. Update tests in `tests/unit/` to cover the new wiring

DO NOT redesign the components. The visual structure is locked. Only
wire data + handlers.

The preview entry stays as-is — it's useful for design iteration.

## Mission 2 — E2E acceptance pass

Run `cd packages/sidetrack-extension && npm run e2e` first. This
launches the MV3 extension in a persistent Playwright-bundled Chromium
profile, captures the ChatGPT, Claude, and Gemini PoC fixtures, and
writes to a temp companion vault under `/tmp`.

Then walk the 22-condition checklist in
docs/milestones/M1-foundation/DEMO.md §"Manual acceptance checklist"
using real Chrome only for the human acceptance items that need a
signed-in provider profile.

For each condition:
1. Verify it end-to-end (companion + extension + real provider tabs)
2. Update the checkbox to:
   - [x] verified — with 1-line evidence (timestamp, thread ID, log line)
   - [ ] **NOT VERIFIED** — with specific reason (not a vague excuse)
3. Save key screenshots to docs/milestones/M1-foundation/evidence/
   M1-validation-<step-number>-<short-name>.png

Setup steps before the walk:
```sh
cd packages/sidetrack-companion && npm install && npm run build
node dist/cli.js --vault /tmp/sidetrack-m1-validation --port 17373 &
cat /tmp/sidetrack-m1-validation/_BAC/.config/bridge.key
cd ../sidetrack-extension && npm install && npm run build
```

Use Computer Use to:
- Open chrome://extensions → Developer mode on → Load unpacked
  from packages/sidetrack-extension/.output/chrome-mv3
- Open the side panel
- Paste the bridge.key from the cat output
- Click Connect → verify "vault: connected · companion: running"
- Walk the 22 conditions with screenshot evidence per condition

Honesty rules:
- Don't fake check marks. Specific reason or [x].
- Time-box: 10 min per condition. If exceeding, mark NOT VERIFIED with
  "exceeded 10-min budget; observed: <what>" and move on.
- Total budget: 2 hours. If hit, document remaining state and stop.

## Constraints

- Don't push to main.
- Per-step commits on this branch (or feature branches off it).
- Don't redesign UX. Wire only.
- Don't touch BRAINSTORM, PRD, AGENTS, ADRs, standards/ except for
  cross-references.
- Don't claim a condition is verified without evidence.
- If you discover regressions in PR #13's prior work, file separately;
  don't bundle.

## Done criteria

Mission 1: components are wired (preview entry can stay; primary
sidepanel.html uses live state). Tests cover the wiring. Build + lint
+ typecheck + test green.

Mission 2: docs/milestones/M1-foundation/DEMO.md has all 22 checkboxes
either [x] verified with evidence or [ ] NOT VERIFIED with specific
reason. evidence/ has screenshots. Final report:
- Count of [x] vs [ ] NOT VERIFIED
- List of NOT VERIFIED with reasons
- Recommendation: "M1 ready to merge as-is" / "M1 ready with N
  follow-up tickets" / "M1 has blocker — see condition X"

When Mission 2 reports back, Claude reviews + decides whether to merge
PR #13 (and PR #20).

Begin with reading: AGENTS.md → packages/sidetrack-extension/
entrypoints/sidepanel/components/index.ts → docs/milestones/M1-
foundation/{README.md,DEMO.md} → poc/local-bridge/README.md.
```

---

## Notes for the human handing this off

- The Codex CLI worker (via /codex-implement) doesn't always pick up
  Computer Use cleanly through the wrapper script. If the dispatch
  hangs (0 bytes after 30s), invoke `codex` CLI directly:
  ```sh
  cd /Users/yingfei/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation
  codex exec --model gpt-5.4 --reasoning medium "$(cat docs/milestones/M1-foundation/CODEX-HANDOFF.md | sed -n '/^## Prompt$/,/^---$/p' | sed '1d;$d')"
  ```
- Or use Codex Desktop: paste the prompt section, let it run with
  Computer Use access; user can see the screen activity but it's
  autonomous.
- M2 conditions don't exist in the M1 DEMO checklist yet — those will
  land in a separate M2 build PR's DEMO.md when M2 build kicks off
  (after M1 merges + the dispatch-build branch is created).
