# Obsidian Integration POC (planning — not yet built)

This is the third POC under `poc/`. It focuses on the highest-leverage gap
in PoC-1/2: **does the Obsidian integration anchor from §24 actually hold up
end-to-end against a real Obsidian vault, plugin set, and user reorganization
behavior?**

PoC-1 (`dogfood-loop`) writes Obsidian-shaped Markdown / `.base` files but
only as filesystem output — no real Obsidian process is involved. PoC-2
(`provider-capture`) does not touch Obsidian at all. So none of the §24
Obsidian anchors are validated against the real software yet.

This planning README captures the **exhaustive validation surface first**
(per the user's "brainstorm before scope cuts" principle) and then
recommends a thin first-iteration slice. **No code is committed yet.**

## Anchors this PoC must respect (from §24, user-confirmed 2026-04-25)

These are v1 product anchors and stay in place for this PoC:

- **Local REST API plugin is the primary integration tier; v1 requires
  the user installs it.** (No filesystem-write fallback in v1 — that was
  §26 PoC-scope-only framing and is not adopted.)
- **MCP is load-bearing** (BAC as both host and server). MCP-server side is
  out of scope for this PoC — covered separately if/when we do a `local-bridge`
  PoC.
- **Canvas + Bases as the dashboard tier** — side panel stays thin;
  user-facing dashboards live in vault.
- **Frontmatter mirror** of workstream-graph entities into YAML.
- **Inbox-first writing pattern** — captures land in `_BAC/inbox/` first.
- **Track + auto-suggest from §24 stands** (calibrated-freshness recall etc.);
  the §26 "manual organize, suggest later" framing is not adopted as v1
  anchor, though manual organization affordances are still tested here.

## What this POC must prove (architectural questions)

Per §26.2 PoC philosophy — only validate where 2–4 plausible architectures
still exist, or where §24 anchors are unverified against real software.

| # | Question | Why it matters |
|---|---|---|
| Q1 | Does **Local REST API PATCH-with-frontmatter-target** actually let us surgically update YAML keys without rewriting the whole file? | The frontmatter-mirror design (§23.4 / §99) depends on it. If only full-file write is reliable, we lose the round-trip-safety story. |
| Q2 | Does **PATCH-with-heading-target** let us update a section (e.g. `## Notes`) without disturbing user-edited surrounding content? | Decides whether captures can incrementally append into a single living note vs. always writing new files. |
| Q3 | Does **`bac_id`-stable identity** survive: rename, move across folders, edit, restart of Obsidian, restart of extension? | Critical invariant from §26.8 S154; also needed for §24's "vault is canonical, daemon is cache" property (S162). |
| Q4 | Do **programmatically-generated `.canvas` files** render correctly in Obsidian Canvas (16-char hex IDs, `\n` literal, edge color/style fields)? | §24.3 and §23.3 bet on this. If Obsidian rejects or mis-renders, the dashboard tier collapses. |
| Q5 | Do **programmatically-generated `.base` files** filter and sort the way we expect (by `bac_id` / `project` / `topic` / `status` / `tags`)? Does Bases re-render reactively when underlying files change? | The "Where Was I" / "Open Questions" / "Decisions" dashboards depend on this. §24.3 marked Bases as "bonus delight, not core dependency" — this PoC tests how true that caveat is. |
| Q6 | Do **wikilink arrays in `related:` frontmatter** show up correctly in Backlinks panel and Graph View? Or do we need explicit `## Related` body sections? | Decides whether frontmatter alone is enough or we need a duplicate body section. |
| Q7 | What's the **first-run cost** for a user who doesn't have Local REST API installed yet? Plugin install + HTTPS self-signed cert acceptance + API key copy/paste — how many steps, where do users drop off? | If first-run is too painful, the §24 "v1 requires plugin" anchor is a real adoption tax. The PoC produces evidence to keep or revisit that anchor at PRD time. |
| Q8 | When **user manually edits frontmatter, moves a file, renames a file, deletes a file** — does BAC see it? With what latency? With what fidelity? | The two-way sync story. If we can only one-way write, the "Obsidian is canonical" framing weakens. |
| Q9 | What's the **bundle-size + latency cost** of the REST client + auth + JSON ops in the extension? | Affects v1 first-run perceived performance. |
| Q10 | Does the **inbox-first writing pattern (§23.5)** actually feel right when the user has 50+ unfiled captures? Or does it become an unloved inbox? | Direct test of the §23 pattern. Mitigations: auto-archive after N days, batch-organize UI. |

## In-scope validation surface (exhaustive — A through N)

Each item below is a candidate for the PoC. Most should land; the **§Recommended
thin slice** at the bottom proposes a subset for first iteration.

### A. Local REST API plugin

- A1. Auth: HTTPS self-signed cert acceptance flow + API-key bearer header.
- A2. Plugin presence detection (probe `/` returns plugin version).
- A3. Vault path detection from plugin metadata.
- A4. CRUD: write Markdown, read it back, update, delete.
- A5. **PATCH-with-frontmatter-target** (Q1): update single YAML key without
  rewriting full file; verify frontmatter formatting preserved.
- A6. **PATCH-with-heading-target** (Q2): append to `## Notes` without
  disturbing other sections.
- A7. **PATCH-with-block-target**: append after a `^block-id` anchor.
- A8. Search: Dataview DQL query (e.g. "all notes with `bac_type: thread`").
- A9. Search: JsonLogic query for structured retrieval.
- A10. Periodic-notes endpoint (daily-note injection — useful for "today's
  research" capture).
- A11. Plugin version compatibility — pin a tested version, error clearly
  if user has older.
- A12. Error handling: plugin disabled, vault not loaded, file locked.

### B. Frontmatter mirror

- B1. Write standard Properties: string, number, date, boolean, list.
- B2. Wikilink arrays in `related:` and verify they render as Backlinks
  (Q6).
- B3. Tag arrays in `tags:` and verify they appear in Tag pane.
- B4. **`bac_id`-stable identity** (Q3): write `bac_id: thread_01HT...` to
  frontmatter; rename file; move file; edit body; verify BAC re-finds the
  file by `bac_id` scan.
- B5. Round-trip: user edits a frontmatter value (e.g. changes `topic` from
  `[High Level Design]` to `[Security]`); BAC scans on next sync; updates
  internal state to match (Q8).
- B6. Concurrent edit: BAC writes while user is editing the same file —
  Obsidian's external-change detection picks it up; no data loss.

### C. JSON Canvas write

- C1. **Spec compliance** (Q4): 16-char hex node IDs, `\n` literal in JSON
  strings, valid `nodes`/`edges` arrays.
- C2. Node types: `text`, `file` (link to vault note), `link` (URL),
  `group` (container).
- C3. Edges with from/to anchors, color, label.
- C4. Render in Obsidian Canvas; verify positions are honored.
- C5. Idiosyncratic Obsidian fields (edge color/style not in core spec) —
  test graceful degrade if we omit them; test inclusion if we add them.
- C6. Regenerate from event log on workstream-graph change — accept that
  user manual position tweaks are lost (or carve out a "user-positioned"
  zone we don't overwrite).
- C7. Performance: at what node/edge count does Obsidian Canvas slow down?
  (Set realistic ceiling for "one canvas per active project".)

### D. Bases (`.base`) write

- D1. **YAML schema** (Q5): write `filters`, `formulas`, `properties`,
  `views` sections per documented Bases syntax.
- D2. View types: `table`, `list`, `card`, `map`. Validate each renders.
- D3. Filter by frontmatter: `bac_type == "thread"`, `project == "..."`,
  `status != "archived"`.
- D4. Formula columns: derived values from frontmatter or file metadata.
- D5. Sort + group by frontmatter property.
- D6. Reactivity: change a file's frontmatter; verify Bases view updates
  without manual refresh.
- D7. Bases plugin version stability — pin a tested Obsidian version, retest
  on each release. Document fallback to Markdown-table-with-Dataview if
  Bases isn't available.
- D8. Generated dashboards to test: `_BAC/dashboards/where-was-i.base`,
  `threads.base`, `decisions.base`, `open-questions.base`.

### E. Internal links + Graph View

- E1. Wikilink density — write notes with N wikilinks each; observe Graph
  View readability for N = 1, 5, 15, 50.
- E2. Link kinds — try encoding `related-explicit:` vs `related-suggested:`
  vs `source:` as separate frontmatter arrays; test how Graph View visually
  separates them (it doesn't, by default — so this may need plugin-level
  styling or a single flat `related:` with body-section nuance).
- E3. Backlinks panel — verify our generated wikilinks show up cleanly
  with our intended labels.
- E4. Unlinked mentions — does Obsidian surface these as candidate links?
  Risk of false connections.
- E5. Graph View filtering — can users filter to "only BAC-tagged notes"
  via tag filter? Test the UX.

### F. Vault structure

- F1. `_BAC/` reserved folder for system files (events, dashboards,
  context-packs); never written to by user manually.
- F2. **Inbox-first** (§23.5, Q10): captures land in `_BAC/inbox/<date>/`;
  user moves out as they organize.
- F3. Folder hierarchy: shallow (project/topic depth 2) vs deep — test what
  Obsidian renders best in File Explorer.
- F4. Filename collisions: two captures with identical title — auto-suffix
  with timestamp or `bac_id`.
- F5. Special characters in titles — sanitize before filename; preserve in
  frontmatter `title:`.
- F6. Folder rename by user — does BAC's path-based assumptions break?
  (Should not, since identity is `bac_id`-keyed per Q3.)

### G. User round-trip

- G1. User opens a note in Obsidian, edits the body, saves; BAC sees the
  edit on next sync (or via Obsidian Local REST API change-watch endpoint
  if available).
- G2. User changes `status: tracked` → `status: archived` in frontmatter;
  BAC removes from active dashboards on next sync.
- G3. User moves a file from inbox to `Projects/SwitchBoard/`; BAC updates
  internal state; the file's `project: SwitchBoard` frontmatter gets
  derived/written automatically.
- G4. User deletes a file; BAC marks the corresponding event as `orphaned`
  rather than deleting state.
- G5. User edits a `.canvas` BAC generated; offer "regenerate (overwrites)"
  or "keep manual" UX in side panel.
- G6. User edits a `.base` BAC generated; same fork UX.

### H. First-run UX (Q7)

- H1. Detect Obsidian installed (probe vault folder if user supplies it).
- H2. Detect Local REST API plugin installed (probe its endpoint).
- H3. Wizard: "1) Install Local REST API plugin → 2) Trust self-signed cert →
  3) Copy API key → 4) Paste here → 5) Pick vault → 6) Done."
- H4. Failure modes per step with clear error + remediation.
- H5. Re-run wizard from Settings if user later disables plugin or rotates key.

### I. Multi-vault

- I1. v1 is single-vault by design (per §24); test that single-vault
  binding is enforced; multi-vault is v1.5+. PoC: confirm second-vault
  selection is rejected with a clear message, not silent confusion.

### J. Bundle + latency

- J1. Bundle-size cost of REST client + auth + JSON ops in the extension.
- J2. Latency for each REST call (write/read/PATCH/search) — establish
  baseline numbers for the side panel's UX budget.
- J3. HTTPS handshake cost — first request vs warm.

### K. Conflict + concurrency

- K1. Two BAC writes to same file (race in background coordinator) —
  serialize per-file or use If-Match etag.
- K2. BAC writes while user is editing in Obsidian — Obsidian shows
  external-change prompt; document expected UX.
- K3. Plugin restart mid-write — retry idempotently.

### L. Adjacent Obsidian community plugins

- L1. **`obsidian-cli-rest`** (Feb 2026) — alternative to Local REST API,
  bundles MCP server. Document whether it's a viable substitute or a
  conflicting plugin.
- L2. **Dataview** plugin presence — useful for the Markdown-table fallback
  to Bases. Test that our `bac_id` / `project` / `topic` / `status` /
  `tags` are queryable.
- L3. **Templater** plugin — test that BAC-written notes don't conflict
  with user templates.
- L4. **Periodic Notes** plugin — alignment with daily-note conventions.

### M. Web Clipper coexistence (§23.6)

- M1. User has Obsidian Web Clipper installed; both write to vault. Test
  that BAC's `_BAC/inbox/` doesn't clash with Web Clipper's clip folder.
- M2. Test importing a Web-Clipper-clipped page into a BAC workstream
  (the existing capture becomes a `Source` artifact).
- M3. Respect Web Clipper templates if user has them — don't reinvent the
  capture template engine.

### N. Dogfood

- N1. Take the BAC project itself (this BRAINSTORM.md, conversations with
  Claude/ChatGPT during design, captured imports/) and run it through the
  PoC end-to-end. Verify "Where Was I" surfaces real workstream state.
  This is the most honest test of whether the integration actually feels
  useful.

## Recommended thin first-iteration slice

Pick the items that **resolve the architectural questions Q1–Q10** with
minimum surface area. Trim list:

| Slice item | Maps to | Why in slice |
|---|---|---|
| A1, A2, A4 — auth + plugin detection + basic CRUD | Q7 baseline | Without this nothing else works |
| A5 PATCH-frontmatter | **Q1** | Single biggest unverified §24 anchor; collapse if doesn't work |
| A6 PATCH-heading | **Q2** | Decides incremental-append-into-living-note feasibility |
| B1, B2, B3 frontmatter mirror basics | foundation | Standard Properties + wikilinks + tags |
| B4 `bac_id`-stable identity | **Q3** | Critical invariant; cheap test |
| B5 round-trip frontmatter edit | **Q8** | Two-way sync sanity |
| C1, C2, C4 minimal `.canvas` write | **Q4** | One project canvas with notes + groups; render check |
| D1, D3, D6 minimal `.base` write | **Q5** | One `where-was-i.base` filtering on `status` + `project`; reactivity test |
| E1 wikilink density | **Q6 partial** | Just "do they show in Backlinks at all" |
| F1, F2 `_BAC/` + inbox folders | foundation | Vault structure baseline |
| H1, H2, H3 first-run wizard | **Q7** | The adoption-cost test |
| N1 dogfood | sanity | The end-to-end honesty test |

**Explicit out of scope for first iteration** (deferred to PoC iteration 2 or
later):

- A8/A9 Dataview/JsonLogic search (use plain REST list+filter for now)
- A10 Periodic notes (later)
- A11 Plugin version pinning (record observed version; ship pin in v1)
- B6 concurrent-edit conflict (test manually; mitigations come later)
- C3 edges, C5 idiosyncratic fields, C6 regen-vs-manual fork UX, C7 perf
  ceiling — all v1 polish
- D2 view types beyond table, D4 formulas, D5 sort/group, D7 version
  stability — v1 polish
- E2/E3/E4/E5 Graph View nuance — let observation drive these
- F3/F4/F5/F6 — use sensible defaults; revisit on dogfood feedback
- G1–G6 round-trip edge cases beyond B5 — v1 polish
- I multi-vault — out of v1 entirely
- J bundle/latency — measure but don't optimize
- K conflict — single-writer assumption for PoC
- L adjacent plugins — note compatibility, don't actively integrate
- M Web Clipper coexistence — note, don't integrate
- MCP server — separate PoC

**Why this slice:** it answers Q1, Q2, Q3, Q4, Q5, Q7, partial Q6, Q8, plus
the dogfood honesty check, in one focused iteration. Q9 (bundle/latency) and
Q10 (inbox UX) are observational — they fall out of the dogfood test
naturally, no separate work.

## Acceptance demo (proposed)

```text
1.  Fresh Chrome profile + freshly installed Obsidian + Local REST API plugin.
2.  Run BAC's first-run wizard — install plugin / trust cert / API key /
    pick vault / done.
3.  BAC creates `_BAC/inbox/`, `_BAC/dashboards/`, `_BAC/events/` folders.
4.  In another tab, capture a chat (re-using PoC-2 capture flow).
5.  Capture lands in `_BAC/inbox/YYYY-MM-DD/<title>.md` with frontmatter:
      bac_id, bac_type: thread, provider, source_url, status, tags
6.  Note: open it in Obsidian, see frontmatter Properties + body.
7.  In side panel, click "Add to project" → pick `SwitchBoard` → pick topic
    `High Level Design`. BAC PATCHes frontmatter `project:` + `topic:`.
8.  In Obsidian, the file's Properties pane updates live (or on next refresh).
9.  Open `_BAC/dashboards/where-was-i.base` in Obsidian. Bases shows the
    thread filtered to project=SwitchBoard.
10. Open `_BAC/canvases/switchboard-map.canvas`. Canvas renders project
    node + topic group + the thread's `file` node.
11. In Obsidian, manually edit the file's `topic:` from `High Level Design`
    to `Security`. Wait <2s; reload BAC side panel; thread now shows under
    Security topic. (Round-trip Q8.)
12. In Obsidian, rename the file from `Claude — Browser-owned MCP.md` to
    `MCP discussion.md`. Reload BAC; BAC still finds the thread (by
    `bac_id`, not path). (Identity Q3.)
13. Dogfood: import the actual BRAINSTORM.md workstream and verify "Where
    Was I" surfaces real entries.
```

## Stack (proposed)

Match PoC-1/2 for tooling continuity:

- WXT + React + TypeScript + Chrome MV3 (extension)
- Vitest unit tests
- Playwright extension e2e (with a real Obsidian process? — see open question)
- HTTPS REST client targeting Local REST API plugin
- Reuse PoC-1 graph store + PoC-2 capture flow as inputs (no rewrite)

## Test plan

- **Unit**: REST client wrapper (auth header, retry, error mapping); frontmatter
  serialization / parsing; canvas builder; base builder; `bac_id` scan logic.
- **Extension e2e fixtures**: a fixture Obsidian-API server (record/replay)
  for deterministic CI runs.
- **Manual integration**: against a real Obsidian + Local REST API on a temp
  vault. Validate Q1–Q10 by hand initially; codify into automated checks
  where possible.
- **Dogfood**: described above (N1 / acceptance step 13).

## Open questions for user before building

1. **Scope sign-off** on the recommended thin slice above. Add anything?
   Cut anything?
2. **PoC name**: `poc/obsidian-integration` (current dir) or another name
   like `poc/obsidian-validations` or `poc/obsidian-anchor`?
3. **e2e harness against real Obsidian**: do we want Playwright to actually
   launch Obsidian and assert on its UI (heavy, fragile), or do we want a
   record/replay fixture of the REST API for CI and rely on manual
   integration for end-to-end (lighter, more honest)?
4. **First-run wizard fidelity**: full polished wizard with screenshots and
   per-step error UX, or minimal "paste vault path + API key here" form
   for the PoC and defer wizard polish to v1?
5. **Provider-capture coupling**: should this PoC depend on PoC-2's
   provider-capture extension (so captures land in vault), or use synthetic
   captures so the Obsidian-side concerns are isolated?
6. **Bases fallback**: do we ship the Markdown-table-with-Dataview fallback
   in this PoC, or assume Bases is present and defer fallback to v1?
7. **What's NOT here that should be**: per "brainstorm before scope cuts",
   any validation areas A–N missing from this list, or any §-anchored
   concern from BRAINSTORM that needs its own check?

**Once scope is signed off, I'll scaffold the project (WXT + tests +
fixtures), then proceed iteratively per existing PoC patterns.**
