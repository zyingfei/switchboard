# Mockup-stage review (2026-04-26)

**Source**: design bundle from claude.ai/design, generated 2026-04-25
in response to `design/MVP-mocks-prompts.md` (Mocks 1–14).

**Status**: design reference, not pixel-perfect target. Use for design
language, interaction patterns, and demo storytelling. Production
implementation does not need 100% adherence.

**Bundle layout**:
- `HANDOFF-README.md` — instructions from claude.ai/design (read first)
- `chats/chat1.md` — designer's reasoning trail; documents the pivot
  from "design canvas" (flat surfaces) to "Stage" (fake-browser +
  side-panel demo)
- `project/SwitchBoard.html` — the **Stage** entry (the file the user
  asked us to implement)
- `project/SwitchBoard Templates.html` — abandoned first iteration
  (design canvas); preserved for reference
- `project/*.jsx` `*.css` — Stage source
- `project/surfaces/*.jsx` — components from the abandoned design
  canvas

**Uploads omitted**: the original bundle included `project/uploads/`
with `bac-design-spec.html`, `compass_artifact_*.md`,
`deep-research-report-*.md`. Those mirror `imports/` which the user
flagged private; not copied here. Originals at
`/Users/yingfei/Downloads/coding-standards-kit/`'s sibling location and
on `poc-planning` `imports/`.

## Mock coverage in the Stage

All 14 mocks present (9 fully ✅, 4 partial ⚠️, 1 mock split into
two surfaces only one of which landed):

| Mock | Status | Notes |
|---|---|---|
| 1 Workboard | ✅ | All 6 sections, banners, masking via `masked` prop |
| 2 Workstream detail | ✅ | Manual checklist with "Add item" pill |
| 3 Tab recovery | ✅ | |
| 4 Move-to picker + drag | ✅ | Drag handlers on `ItemRow` + `MoveTo` modal |
| 5 Packet composer | ✅ | Kind/template/scope/target selectors, redaction summary, token estimate |
| 6 Dispatch confirm | ⚠️ | Redaction + token + screen-share + paste-mode lock present; **missing** captured-page injection scrub UI |
| 7 Inline review | ✅ | 5-verdict picker, per-span comments, save / submit-back / dispatch-out |
| 8 First-run wizard | ⚠️ | Shows BOTH HTTP and Native Messaging install paths (predates ADR-0001 which locks HTTP-only) |
| 9 Settings | ⚠️ | Missing per-workstream privacy flag, MCP section, MCP write-tools trust list, redaction-rules management, packets/auto-download |
| 10 System states | ✅ | Banner system in Workboard |
| 11 Privacy-flag masked | ✅ | `masked` prop applied across panel components |
| 12 Coding session attach | ✅ | |
| 13 Inbound + Recent dispatches | ⚠️ | Inbound section in Workboard ✅; **Recent Dispatches view missing** |
| 14 Annotation capture | ✅ | |

## Gaps vs the locked decisions (PR #11 §11)

The design bundle predates the 2026-04-26 decisions log. Gaps that
post-date the design:

- **Sidetrack rename** — design uses "SwitchBoard" / `npx switchboard-companion` / `~/Documents/SwitchBoard-vault`. Per Q8 + the rename policy, production code uses Sidetrack; design-mockup naming stays for fidelity to the artifact.
- **Wizard install path** (Mock 8) — show only HTTP loopback per ADR-0001.
- **Per-workstream `private/shared/public` flag** (Settings + WorkstreamDetail) — substantive privacy control after Q6 demoted screen-share auto-detect.
- **MCP write-tools approval surface** + **per-workstream trust list** — new from Q1+Q7.
- **MCP section in Settings** — server status, audit log, tools enumeration (per §6.2.6).
- **Captured-page injection scrub UI** — §24.10 ship-blocking primitive; show in dispatch confirm when source has injection-pattern detection.
- **Recent Dispatches view** — Mock 13 second half; chronological `DispatchEvent` log paired with Inbound.
- **Redaction rules management** — Settings: list of built-in + user-added rules.
- **Auto-download per-workstream override** — Settings: per Q3 Mixed default + override.

These gaps are NOT bugs in the design — they're follow-up scope from
decisions made after the design was generated. Apply them when
porting to production code, not to the design artifact itself.

## How to view

Open `project/SwitchBoard.html` in a browser. The Stage:
- Top: scenario tabs (Stripe / ChatGPT / Obsidian) + Play demo
- Left ~70%: fake browser with the selected scenario
- Right ~30%: live interactive side panel
- Gear icon: Tweaks panel (state controls + quick-open every modal)

Demo flow: highlight in Stripe docs → annotation → workstream update →
review → packet → dispatch → reply → recovery.

## Implementation status

This bundle is **reference only**. Production implementation lands as
a separate effort, not by porting these JSX files directly. See PRD
§5 (architecture), `standards/03-ts-browser-plugin.md`, and the
`packages/sidetrack-extension/` (when scaffolded) for the production
target.
