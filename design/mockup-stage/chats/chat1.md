# Interactive Templates

_Started 2026-04-25 07:24 UTC_

---

## User

based on the design can you create interactive templates

## Assistant

I'll start by reading the attached files to understand what "the design" refers to and what kind of interactive templates you need.

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

I have a clear picture. Let me see the rest of the spec to understand all the surfaces, then plan templates.

_[tool: read_file]_

I'll get a clearer view of the middle of the spec to find all the distinct surfaces, then ask focused questions before building.

_[tool: grep]_

_[tool: snip]_

Now I have a strong picture of SwitchBoard's design system and surfaces. Before building, let me ask focused questions to scope this right.

_[tool: questions_v2]_

## User

Questions answered:
- what_templates: All of them
- fidelity: Clickable demo — buttons work, state changes, but content is fixed
- presentation: Design canvas — all surfaces side-by-side, draggable, with focus-zoom
- happy_path: Both — surfaces stand alone but a 'Play demo' button walks the flow
- tweaks: Decide for me
- extra_surfaces: all related

## Assistant

Got it. Plan: design_canvas with all 8 surfaces from the spec + 5 extras (workstream canvas, context pack, drift, fork-converge, inbox), each clickable, with a Play Demo button that walks the happy path. Tweaks: theme/density/accent/workstream/screen-share/drift.

Let me set up the project.

_[tool: update_todos]_

_[tool: copy_starter_component]_

_[tool: copy_starter_component]_

Let me peek at the design_canvas API briefly so I use it correctly.

_[tool: grep]_

_[tool: snip]_

Now let me build the design system CSS, then the surface components. I'll keep each surface in its own file.

_[tool: write_file]_

_[tool: snip]_

Now I'll build the icons + shared bits, the surfaces, and the main app. I'll keep each surface tight.

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: list_files]_

Let me check what's already in place and what surfaces I've built.

_[tool: list_files]_

_[tool: read_file]_

Good. All 8 spec surfaces + extras are built. Now I need: the Play Demo orchestrator, Tweaks panel, and the main design canvas composition. Let me check the existing pieces and then assemble.

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

Now let me build the Tweaks panel, Play Demo orchestrator, and main composition file.

_[tool: read_file]_

_[tool: snip]_

_[tool: read_file]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

Now let me build the main composition file with Play Demo orchestrator and Tweaks.

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: done]_

_[tool: get_webview_logs]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

All 13 surfaces are live in the design canvas with Play Demo bar (top) and Tweaks panel:

- **Anchor** — Side panel (default / déjà-vu / screen-share-safe)
- **Hook** — Source page, on-page flyout, dispatch preflight
- **Architecture** — Obsidian Bases dashboard, YAML mirror, workstream `.canvas` graph
- **Moat** — MCP server, Context Pack export, Fork & converge
- **Onboarding** — Connect-Obsidian wizard, Inbox
- **Safety** — Drift delta-paste

Hit **Play demo** in the top bar to walk highlight → preflight → dispatch → vault pulse → déjà-vu. Tweaks (gear icon) toggles theme/accent/density, workstream data, screen-share mode, and drift detection.

## User

this is a bit unexpected than i thought, should i get a few interactive pages (as chrome panel) and left side showing mock pages if it's a demo? i'm new to web design sorry

## Assistant

_[tool: snip]_

No need to apologize — you're right, that's a great instinct. What I built is a **design exploration canvas** (all surfaces laid out flat, like Figma) which is good for reviewing the *system*, but it's not the right shape for a **demo**.

For a demo, you want it to feel like a real moment in someone's day:

- **Left ~70%**: a fake browser window showing a real-looking page (Stripe docs, a Notion page, etc.)
- **Right ~30%**: the actual SwitchBoard Chrome side panel, pinned, live and interactive
- **Floating**: the on-page flyout when you "highlight" text, the preflight modal when you dispatch
- **Switchable backdrop**: tabs to swap the left side between "Stripe docs", "Obsidian vault", "ChatGPT thread" so you can show off different scenarios from one screen

Basically a **stage** showing SwitchBoard *in situ*, with a Play button that scripts the highlight → flyout → preflight → side-panel-update story across the whole stage.

Two ways I can take this:

**Option A — Replace** the design canvas with a single hi-fi stage like above (one screen, scripted demo, feels like a real product walkthrough).

**Option B — Add** the stage as the *first* thing you see, keep the design canvas below as a "system reference" for when you want to look at any one surface in isolation. Best of both.

I'd recommend **Option B** — you already have all 13 surfaces built, so the stage just *uses* them. Want me to build it?

## User



## Assistant

_[tool: snip]_

_[tool: update_todos]_

_[tool: list_files]_

Let me find the sketch thumbnail.

_[tool: list_files]_

_[tool: grep]_

Sketch isn't materialized; I'll proceed from the brief. Plan locked in:

**Stage shell:** Chrome window taking the full viewport. Left ~70% = a fake page (Stripe docs / ChatGPT / Obsidian — switchable). Right ~30% (≈400px) = the real, interactive SwitchBoard side panel pinned. Modals (recovery dialog, packet composer, dispatch confirm, move-to picker) overlay the whole stage. Top: scenario tabs + Play demo button.

I'll build the side panel as the centerpiece (Mocks 1, 2, 4, 7, 9, 10, 11, 13, 14) since it's the actual product, plus the 5 modals (3, 4-picker, 5, 6, 8, 12) as overlays you can open from buttons in the side panel.

Let me check what's reusable from before, then build fresh.

_[tool: list_files]_

_[tool: read_file]_

Good. I'm scrapping the design-canvas approach and rebuilding as a single Stage. I'll keep `styles.css` (design tokens), `shared.jsx` (icons), `tweaks-panel.jsx` (controls), and reuse pieces of the old surfaces where helpful, but the rest is fresh.

Let me build it. I'll work in chunks — stage shell first, then side panel, then modals.

_[tool: write_file]_

Now build the icons + fixtures, then the side panel views.

_[tool: write_file]_

Now build the side panel — Mocks 1, 2, 7, 13 (workboard, workstream detail, review composer, inbound) — in one file.

_[tool: write_file]_

_[tool: snip]_

_[tool: update_todos]_

Now build modals (3, 4-picker, 5, 6, 8, 9, 10-states, 12-coding, 14-annotation) and the Stage shell with fake pages and Play demo.

_[tool: write_file]_

_[tool: snip]_

Now build the fake page contents (Stripe docs, ChatGPT thread, Obsidian vault) and the main Stage app file.

_[tool: write_file]_

_[tool: snip]_

Now the main Stage app + entry HTML.

_[tool: write_file]_

_[tool: snip]_

Now write the entry HTML and verify the styles.css already has the design tokens I'm referencing.

_[tool: grep]_

_[tool: grep]_

_[tool: snip]_

_[tool: read_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Rebuilt as a proper demo stage:

- **Left ~70%**: fake browser window with three switchable scenarios — Stripe docs, ChatGPT thread, Obsidian vault — including realistic chrome (traffic lights, URL bar with SwitchBoard's pinned extension icon, tabs).
- **Right ~30%**: the real, interactive SwitchBoard side panel (Mocks 1, 2, 7, 9, 10, 11, 13).
- **Modals overlay the whole stage**: Tab recovery (3), Move to… (4), Packet composer (5), Dispatch confirm (6), First-run wizard (8), Coding-session attach (12), Annotation capture (14).
- **Top bar**: scenario tabs + Play demo button (highlight → annotate → workstream update → review → packet → dispatch → reply → recovery).
- **Tweaks (gear)**: scenario, screen-share masking, companion/vault state, plus quick-open buttons for every modal.

Try clicking the highlighted line in the Stripe docs, or hit Play demo to see the full flow.

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Fixed the layout — switched stage-body to flex with proper min-height: 0 chains so the browser pane and side panel fill the viewport instead of overflowing, and stopped the scenario tabs from wrapping.

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

<budget:5000>

_[tool: fork_verifier_agent]_

_[tool: snip]_

Fixed — that was a careless `//` comment at the top of the CSS file invalidating the whole stylesheet. Now using proper `/* */` syntax so the layout rules actually apply.

## User

Verifier agent check completed

## Assistant

<budget:8000>

_[tool: snip]_

_[tool: read_file]_

<budget:8000>

The CSS file is correct on disk. The verifier may be hitting a cache. Let me probe directly to confirm and also check if there's a parser issue further down.

_[tool: eval_js]_

## Assistant

<budget:6000>

_[tool: snip]_

Confirmed — `.stage` rule is missing entirely (169 rules but no `.stage`), and `.stage-body` still shows the OLD grid. There's a parser break between lines 4 and the `.stage-body` rule. Let me find it.

_[tool: eval_js]_

<budget:6000>

_[tool: snip]_

<budget:6000>

The browser parsed `.stage-toolbar` first which means `.stage` was dropped. The issue: `inset: 0` may be confusing some parsers, but more likely: the served file still has stale content. The `.stage-body` shown still has `grid; grid-template-columns: 1fr 412px` despite my edit. The browser is serving stale CSS. Let me overwrite stage.css fresh.

_[tool: read_file]_

<budget:6000>

_[tool: snip]_

<budget:6000>

The file on disk is correct but the browser served stale CSS. I'll add a cache-buster to the link tag.

_[tool: str_replace_edit]_

<budget:5000>

_[tool: snip]_

_[tool: done]_

<budget:4000>

_[tool: snip]_

_[tool: eval_js]_

<budget:3000>

_[tool: snip]_

_[tool: fork_verifier_agent]_

<budget:2000>

The CSS is now loading correctly (170 rules, `.stage` present, `.stage-body` is flex). Browser cache was the issue — adding `?v=2` to the link forced a reload.

## User

this add item is ugly

## Assistant

<budget:5000>

_[tool: snip]_

_[tool: grep]_

<budget:5000>

_[tool: snip]_

_[tool: read_file]_

_[tool: grep]_

<budget:4000>

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

<budget:3000>

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: done]_

<budget:2000>

_[tool: snip]_

Cleaner Add item — small pill-style chip with a circular plus glyph that fills on hover, in the display serif instead of mono. Click the workstream in Active work to see it under Manual checklist.

