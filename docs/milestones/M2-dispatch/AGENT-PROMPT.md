# M2 — Agent handoff prompt

Paste-ready prompt for the coding agent that will build M2 (Dispatch +
Safety). Self-contained: agent reads this prompt + the linked
references and starts without prior conversation context.

> Pasting tip: include a one-liner pointing the agent at this repo
> path (`/Users/yingfei/Documents/playground/browser-ai-companion`)
> when you hand it over. The prompt assumes the agent can read files
> there.

---

## Prompt

```
You're picking up the second production milestone (M2 — Dispatch +
Safety) for the Sidetrack project at
/Users/yingfei/Documents/playground/browser-ai-companion. You take
charge of branch `m2/dispatch` (create it off main when M1 has
landed; this prompt and the milestone scope live at
docs/milestones/M2-dispatch/). Final landings can target either
feature branches off m2/dispatch (one per sequencing step) or
commits directly on m2/dispatch — your call. Don't push to main.

# PREREQUISITE: M1 must be merged

This milestone builds on packages/sidetrack-{companion, extension,
mcp} and (if it exists) packages/sidetrack-shared. Verify:

  ls packages/sidetrack-companion packages/sidetrack-extension \
     packages/sidetrack-mcp 2>/dev/null

If any are missing, M1 hasn't landed yet — STOP and tell the user.
M2 has nothing to build on without M1.

# Required reading (~4 hours, do not skip)

In this order, before writing any code:

1.  AGENTS.md (5 min) — repo conventions + milestone-PR convention
    (added in PR #14).
2.  M1 deliverables: packages/sidetrack-{companion,extension,mcp}/
    README.md (20 min) — the existing scaffold M2 builds on.
3.  PRD.md §6.1.9 (Packet generation), §6.1.10 (Inline review §28),
    §6.1.13 (Safety primitives — the four §24.10 entries),
    §6.1.14 (MCP write tools + per-workstream trust), §6.2.1
    (Coding session attach), §6.2.2 (Async dispatch ledger),
    §6.2.3 (Auto-download), §6.2.5 (Annotation capture), §6.2.6
    (MCP read-only — adds writes per §6.1.14), §6.3.2 (MCP host
    role), §10 (Notebook integration Case A — full sync-out)
    (40 min).
4.  BRAINSTORM.md §24.4 (Hypothesis client, for future P3 work),
    §24.5 (MCP host AND server), §24.10 (ship-blocking safety
    primitives — full text, this is load-bearing for M2), §28
    (inline review primitive — full text) (20 min).
5.  docs/adr/0001-companion-install-http-loopback.md (5 min) —
    install path locked; M2 wizard reflects HTTP-only.
6.  CODING_STANDARDS.md (10 min refresh).
7.  standards/01-api-component.md + templates/api-endpoint-rfc.md +
    configs/openapi/openapi.base.yaml + configs/openapi/api-style-rules.yaml
    (15 min) — companion's new endpoints in M2.
8.  standards/02-mcp-components.md + templates/mcp-capability-spec.md
    (15 min) — write tools + host role.
9.  standards/03-ts-browser-plugin.md (15 min) — extension's new
    surfaces (composer, dispatch confirm, review composer, annotation
    composer, settings additions, content-script for span selection).
10. poc/dogfood-loop/README.md + skim src/ for: redaction-pipeline
    primitive, dispatch preflight UX, fork/converge, prompt-run shape.
    M2 lifts these patterns (40 min).
11. poc/provider-capture/README.md + skim ChatGPT extractor as the
    template for the new Codex extractor (15 min).
12. design/MVP-mocks-prompts.md Mocks 5, 6, 7, 8, 12, 13, 14 (15 min)
    — UI surface for M2.
13. design/mockup-stage/REVIEW.md (5 min) — flagged design gaps to
    FIX during build:
    - Mock 6 missing captured-page injection scrub UI (add it)
    - Mock 8 wizard shows BOTH HTTP and Native Messaging install
      paths — REMOVE the NM card per ADR-0001
    - Settings missing per-workstream trust list, MCP section, etc.
      — add per spec
14. Open design/mockup-stage/project/SwitchBoard.html in a browser
    (15 min) — see all M2 mocks live.

If anything contradicts after reading: AGENTS.md and BRAINSTORM
anchors win. CODING_STANDARDS.md wins for code-quality questions.
ADR-0001 (HTTP loopback only) wins over the design mockup's
NM-considered card.

# What to build

Read docs/milestones/M2-dispatch/README.md for the full scope. This
is the **active orchestrator** milestone — adds dispatch + safety
chain + inline review + remaining mocks on top of M1's tracker.

THE SAFETY CHAIN IS LOAD-BEARING. The four §24.10 primitives
(Redaction + token-budget + screen-share-safe + injection-scrub) are
ship-blocking — do not ship dispatch without all four operational at
the dispatch boundary. They're packaged as packages/sidetrack-shared
so the composer, dispatch confirm, and inline review all use the
same primitives.

The README has 25 numbered sequencing steps. Land per-step commits
or PRs. **Steps 2–5 (shared safety primitives) MUST land before
step 11 (composer)** — the composer cannot ship without the safety
chain. **Step 6 (API design RFC + OpenAPI extension) is a hard gate
before any new companion route.**

# What to NOT build (frequent agent over-reach)

Defer to M3+:
- Smart recall (vector via transformers.js + MiniLM) — M3.
- Persistent web annotation overlay (Hypothesis-style anchoring) — M3.
  M2 ships LIGHTWEIGHT capture only (selection + note + URL); the
  persistent-anchor-on-revisit case is M3.
- Multi-vault routing — M3+.
- Notebook structured macro sync-back (PRD §10 Case C) — M4+ spike,
  needs schema versioning + 3-way merge + conflict UI design.
- Suggestion layer ("looks related to X") — M3.
- `--install-service` for companion auto-start — M2.5/M3.
- Cross-user review aggregation — never.
- Mobile — separate product.

The M2 README has a full out-of-scope FAQ. Re-read it before opening
scope.

# Naming

Product name is **Sidetrack** (locked per ADR / PR #11). Existing
`_BAC/` namespace preserved as a stable vault convention — do not
rename. Workstream-tree examples use "Switchboard / MVP PRD" — that's
the user's example workstream name from the napkin, preserve as-is.

# E2E acceptance — the bar to pass

The milestone ships when ALL of these pass (full criteria in
docs/milestones/M2-dispatch/README.md §"E2E acceptance criteria"):

Safety chain (the §24.10 quartet):
1. Redaction fires on a fake API key → output contains marker, not key.
2. Token budget warns at 80%, blocks at 100%.
3. Screen-share-safe auto-mask within 5s of getDisplayMedia start.
4. Injection scrub wraps captured-page content in <context>.

Dispatch primitives:
5. Compose Research Packet (Web-to-AI checklist template).
6. Dispatch in paste-mode copies to clipboard, opens target tab.
7. DispatchEvent recorded in Recent Dispatches.
8. Inbound reply chains: target reply flips status to `replied` +
   M1 Inbound notification fires.

Inline review (§28):
9. Span selection → composer with verdict + comments.
10. Submit-back composes follow-up turn into same chat (paste-mode).
11. Dispatch-out bundles reviewed turn + annotations as Research
    Packet for another AI.
12. ReviewEvent persists to vault.

MCP write tools + host:
13. Write tool requires approval (untrusted scope).
14. Trust opt-in flips to silent execution within scope.
15. Trust scope boundary respected (out-of-scope still requires
    approval).
16. Audit log every write call.
17. MCP host surfaces installed external servers + dispatchable
    tools.

Coding session:
18. Attach + "Open in {tool}" runs resume command.
19. bac.coding_sessions() returns live data.

Annotation:
20. Right-click "Save to Sidetrack" → composer → workstream picker.
21. Saved annotation can become a §28 review source.

Auto-download + projection:
22. Per-workstream auto-download default (off root, on project,
    overridable).
23. PRD §10 Case A vault projection: Source notes + .canvas + .base
    render natively in Obsidian.

Codex web (if shipped):
24. Codex web capture lands in vault within 30s.

Failure modes:
25. Companion-down dispatch queues + prompts on reconnect.
26. Rate-limit fallback to clipboard mode.

Standards:
27. companion: lint + typecheck + test + openapi-lint green.
28. extension: lint + typecheck + test + build + e2e green.
29. mcp: lint + typecheck + test green.
30. shared: lint + typecheck + test green.
31. No `any` across boundaries; no hidden global state.
32. All four checklists/* filled in STANDARDS-CHECK.md.
33. Every new MCP write tool has mcp-capability-spec.md doc; every
    new endpoint has api-endpoint-rfc.md doc.

# Constraints

- Do NOT push to main.
- Do NOT modify M1's deliverables in packages/* unless absolutely
  required for an extension. If you find a real M1 bug, file a
  separate fix PR; don't bundle with M2.
- Do NOT modify the PoCs under poc/* unless adding the Codex web
  extractor (step 22). For everything else, lift behavior, capture
  as tests, then implement to standards in packages/.
- Do NOT modify BRAINSTORM, PRD, AGENTS, ADRs, or the standards kit.
  If you find a real error, file separate fix PR.
- Do NOT add features outside the scope above. Document any out-of-
  scope discoveries in docs/milestones/M2-dispatch/SURPRISES.md.
- Do NOT enable any auto-send by default for any provider. Paste-mode
  is the v1 default forever (per Q5).
- Default to per-step commits with clear messages. PRs per step
  encouraged for review velocity.

# Done

When E2E acceptance + standards gates pass:
- Write docs/milestones/M2-dispatch/DEMO.md (full dispatch loop
  demo + each safety primitive demonstrated firing + Codex example
  if shipped).
- Write docs/milestones/M2-dispatch/STANDARDS-CHECK.md (filled
  checklists from checklists/).
- Update docs/milestones/M2-dispatch/README.md status from
  "planning" to "complete" with retrospective + obvious M3
  candidate (expected: smart recall + multi-vault + persistent
  annotation).
- Open final PR titled "M2: Dispatch + Safety — packets, reviews,
  MCP writes, host role" against main.

Time-box: ~4-5 weeks total. Per-step time-box 5 calendar days. If
any step exceeds, stop and flag.

Start by verifying M1 has landed. Then required reading. Then code.
```

---

## Notes for the human handing this off

- **Sequencing constraints matter**: shared safety primitives (steps
  2-5) MUST land before composer (step 11). API design (step 6) MUST
  land before any new route (steps 7-8). Composer (step 12) before
  dispatch confirm (step 13) before Recent Dispatches (step 14).
- **Codex web (step 22) is parallel-safe** — independent track that
  can land any time during M2.
- The agent will likely want a `packages/sidetrack-shared/` package
  for the safety primitives if M1 didn't already create one.
  Encourage it.
- Expect M2 to surface real edge cases the design didn't anticipate
  (e.g., what does dispatch confirm look like when ALL four safety
  guards are firing at once?). The agent should document these in
  SURPRISES.md and propose UX in the build.
- M3 scope is intentionally pre-named so the M2 retrospective frames
  "what's M3" with no ambiguity (smart recall + multi-vault +
  persistent annotation).
- If the agent finishes M2 in <3 weeks, scope was probably too small
  or quality is sacrificed; if >6 weeks, scope was probably too big
  and should be split (e.g., M2a = safety + composer + dispatch +
  inline review; M2b = MCP writes + host + projection + Codex).
