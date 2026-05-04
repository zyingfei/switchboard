# SwitchBoard v2 — reference-only design artifacts

This directory holds the SwitchBoard v2 handoff bundle (extracted from
`SwitchBoard-handoff.zip`). It is **reference-only** — read for design
intent, do not import from this directory in production code.

Production code lives in `packages/sidetrack-extension/entrypoints/sidepanel/`
and is iterated against the live PRD in `PRD.md`.

## Contents

- `HANDOFF-README.md` — original Claude Design handoff README; reads as
  if addressed to a coding agent ("Read SwitchBoard v2.html first…"),
  but for our purposes it is documentation of the v2 design intent.
- `project/SwitchBoard v2.html` — primary v2 surface mockup.
- `project/{stage,surfaces,modals,...}.jsx` — the prototype's component
  tree. JSX is the design medium, **not** the implementation pattern;
  match visual output, not the file structure.
- `project/uploads/` — supporting design briefs and external research
  (BAC design spec, comp review, etc.).

## v1 → v2

The earlier v1 mockup lives at `../mockup-stage/` and is preserved for
lineage. Where v1 and v2 diverge, **v2 is the current intent**. v1 is
historical; do not extend v1.

## Implementation status

Most v2 surfaces are already wired in the live sidepanel. Remaining
gap closure is tracked in commit history (search for `switchboard-v2`)
and PR #86 / its successors. Open issues / TODOs that touch this
directory should reference specific files here for design intent
rather than copying JSX into production.
