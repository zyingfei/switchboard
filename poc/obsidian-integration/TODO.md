# TODO — `poc/obsidian-integration`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **add `README.md`** documenting what was built (architecture,
> resolved questions Q1–Q10, live-validation results, lessons).
>
> `README.md` today is the **planning** doc. The post-build README will
> replace it (or be a sibling `BUILT.md` while the planning doc is
> archived — author's choice at completion time).

## Status today

Planning only. `README.md` captures the exhaustive validation surface
A–N, the architectural questions Q1–Q10, and a recommended thin first-
iteration slice. Awaiting user scope sign-off before scaffolding.

## Remaining scope

### Pre-build gates

- [ ] **User scope sign-off** on the recommended thin slice in `README.md`
  (A1/A2/A4/A5/A6 + B1–B5 + C1/C2/C4 + D1/D3/D6 + E1 + F1/F2 +
  H1/H2/H3 + N1).
- [ ] Resolve the seven open questions at the end of the planning
  README (PoC name, e2e harness fidelity, wizard polish level,
  coupling with PoC-2, Bases fallback, anything missing).

### Scaffolding

- [ ] Initialize WXT + React + TypeScript MV3 project mirroring PoC-1/2
  layout (`entrypoints/`, `src/`, `tests/`, `wxt.config.ts`,
  `vitest.config.ts`, `playwright.config.ts`).
- [ ] Vendor / depend on whatever Obsidian Local REST API client is
  cleanest — vetted community client or thin in-house wrapper around
  `fetch` with HTTPS self-signed-cert handling.

### Local REST API integration (resolves Q1, Q2, Q7)

- [ ] **A1** auth: HTTPS self-signed cert + API-key bearer.
- [ ] **A2** plugin presence detection (probe plugin endpoint for
  version).
- [ ] **A4** basic CRUD: write Markdown, read back, update, delete.
- [ ] **A5** PATCH-with-frontmatter-target — surgical YAML key updates
  without rewriting full file. **Resolves Q1.**
- [ ] **A6** PATCH-with-heading-target — append to `## Notes` without
  disturbing other sections. **Resolves Q2.**
- [ ] **H1/H2/H3** first-run wizard: detect Obsidian → install plugin →
  trust cert → copy / paste API key → pick vault → done. **Resolves
  Q7.**

### Frontmatter mirror (resolves Q3, Q6, Q8)

- [ ] **B1** standard Properties: string, number, date, boolean, list.
- [ ] **B2** wikilink arrays in `related:` — verify Backlinks panel
  picks them up. **Resolves Q6 partial.**
- [ ] **B3** tag arrays in `tags:` — verify Tag pane populates.
- [ ] **B4** `bac_id`-stable identity: write `bac_id` to frontmatter;
  rename file; move file; edit body; restart Obsidian; restart
  extension; verify BAC re-finds the file by `bac_id` scan.
  **Resolves Q3.**
- [ ] **B5** round-trip: user edits a frontmatter value in Obsidian;
  BAC scans on next sync; updates internal state to match.
  **Resolves Q8.**

### JSON Canvas write (resolves Q4)

- [ ] **C1** spec compliance: 16-char hex node IDs, `\n` literal,
  valid `nodes` / `edges`.
- [ ] **C2** node types `text` and `file`; verify render in Canvas.
- [ ] **C4** generate one project canvas (e.g. `_BAC/canvases/
  switchboard-map.canvas`) with project node + topic groups + thread
  file-nodes; verify positions honored. **Resolves Q4.**

### Bases write (resolves Q5)

- [ ] **D1** YAML schema: `filters`, `properties`, `views`.
- [ ] **D3** filter by frontmatter (`bac_type == "thread"`,
  `project == "..."`, `status != "archived"`).
- [ ] **D6** reactivity test: change a file's frontmatter; verify
  Bases re-renders. **Resolves Q5.**
- [ ] Generate `_BAC/dashboards/where-was-i.base` for the dogfood test.

### Internal links + Graph View baseline (resolves Q6 partial)

- [ ] **E1** wikilink density baseline: write notes with N wikilinks
  each; eyeball Graph View at N = 1, 5, 15. Document a recommended
  density range.

### Vault structure

- [ ] **F1** `_BAC/` reserved-folder convention (events, dashboards,
  canvases, context-packs, inbox).
- [ ] **F2** inbox-first writing pattern: captures land in
  `_BAC/inbox/<date>/<title>.md`.

### MCP contract owner role for `bac.workstream` and `bac.context_pack`

- [ ] Implement `getWorkstream(id)` reader: query frontmatter mirror
  for entities (Workstream / Bucket / Source / PromptRun /
  ContextEdge) belonging to a workstream. Match the canonical shape
  from `poc/dogfood-loop` contract module.
- [ ] Implement `getContextPack(filter)` reader: assemble portable
  Markdown bundle from organized vault (project / topic / tags /
  linked notes / promoted decisions / open questions). Match contract.
- [ ] Decide query path: Local REST API Dataview / JsonLogic search vs
  direct file reads + frontmatter parse. Document the latency vs
  dependency tradeoff.

### Dogfood (resolves "is it actually useful")

- [ ] **N1** Take this BRAINSTORM workstream itself (BRAINSTORM.md +
  conversations + imports) and run it through the PoC end-to-end.
  Verify "Where Was I" surfaces real workstream state. This is the
  single most honest test.

### Tests

- [ ] Unit (Vitest): REST client wrapper, frontmatter serializer /
  parser, canvas builder, base builder, `bac_id` scan.
- [ ] Extension e2e (Playwright): record / replay fixture of the
  Obsidian REST API for deterministic CI runs (per the open question
  in the planning README — pick fixture, not real-Obsidian-launch).
- [ ] Manual integration: against a real Obsidian + Local REST API on
  a temp vault, run the 13-step acceptance demo from the planning
  README.

### Documentation

- [ ] On completion: delete this `TODO.md` and write the post-build
  README documenting:
  - architecture chosen (REST client shape, frontmatter conventions,
    canvas / base writers)
  - Q1–Q10 resolution outcomes (especially Q1 PATCH-frontmatter and
    Q3 `bac_id` identity)
  - first-run wizard UX with screenshots
  - dogfood lessons (what felt right, what didn't)
  - what carried forward to v1 anchors and what got trimmed

## Out of scope here

Per the planning README's explicit deferrals:

- A8 / A9 Dataview / JsonLogic search — use plain REST + filter for now
- A10 Periodic notes — later
- A11 plugin version pinning — record observed version; pin in v1
- B6 concurrent-edit conflict — manual test only
- C3 / C5 / C6 / C7 canvas polish — v1
- D2 / D4 / D5 / D7 bases polish — v1
- E2–E5 Graph View nuance — v1
- F3–F6 vault-structure polish — v1
- G1–G6 round-trip edge cases beyond B5 — v1
- I multi-vault — out of v1 entirely
- J bundle / latency optimization — measure here, optimize in v1
- K conflict / concurrency — single-writer assumption for PoC
- L adjacent-plugin integration — note compatibility, no integration
- M Web Clipper coexistence — note, no integration
- MCP server transport — `poc/mcp-server`
- Recall / vector — `poc/recall-vector`
