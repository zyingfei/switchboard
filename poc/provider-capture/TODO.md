# TODO — `poc/provider-capture`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **update `README.md`** to document what landed (the existing
> README covers the original PoC scope and live-validation results to
> date).

## Status today

This PoC's original scope is complete: see `README.md` for the proven
provider detection + visible-content extraction + local persistence flow.
Live validation passed for Gemini signed-in conversations (15 turns /
23,570 chars after extractor patch) and ChatGPT shared/canvas pages.
Gaps captured below.

## Remaining scope

### Close live-validation gaps

- [ ] **Real ChatGPT loaded conversation-thread capture** (live, signed
  in, normal `chat.openai.com/c/<id>` page). Currently only shared/
  canvas paths are live-proven. Extend selectors / fallback as needed
  and lock in regression fixtures.
- [ ] **Real Claude logged-in capture** (live, signed in, normal
  `claude.ai/chat/<id>` page). Currently only fixture-proven.
  Validate selectors against the real DOM and lock in fixtures.
- [ ] Add a regression-test pass for both providers from real captures
  to prevent silent breakage on provider redesigns.

### Contract owner role for `bac.recent_threads`

This folder is the data source for the MCP tool that lists every chat
thread the user has open across providers — the unique value the BAC
MCP server gives a coding agent.

- [ ] Define a `TrackedThread` type matching the canonical shape from
  `poc/dogfood-loop`'s contract module: `provider`, `threadId`,
  `threadUrl`, `title`, `lastTurnAt`, `captureCount`, `status`.
- [ ] Expose a reader interface (e.g. `getTrackedThreads(filter?)`)
  that `poc/mcp-server` calls. Keep storage details (today
  `chrome.storage.local`) behind the interface so storage can move
  later without touching MCP wiring.

### Storage handoff decision

- [ ] Decide whether captures stay in `chrome.storage.local` for v1, or
  migrate into the vault as `Source` artifacts via
  `poc/obsidian-integration`. Document the choice and, if migrating,
  define the migration path (one-time backfill + dual-write window).

### Selector durability

- [ ] Establish a per-provider selector-canary test that runs on every
  capture-ready tab load. Surface a clear "selector may be broken"
  warning + clipboard-mode fallback in the side panel.
- [ ] Capture telemetry-free local counters of selector misses (no
  network calls), so the user can see "ChatGPT extractor health: 8/10
  recent captures clean" in the side panel.

### fetch / SSE interception (optional, defer to v1 if heavy)

§24 anchor: "fetch / SSE interception is primary, DOM is fallback." This
PoC went DOM-first. Decide whether to add fetch interception here or in
v1 implementation work.

- [ ] Decide: add MAIN-world `window.fetch` / `XMLHttpRequest` override
  at `document_start` in this PoC, or defer to v1 build.
- [ ] If added: validate that fetch interception captures structured
  turn data more durably than DOM scraping for at least one provider.

## Out of scope here

- Prompt injection / response automation — that lives with v1 dispatch
  work, not this capture PoC
- Cloud sync — never in scope
- End-to-end local encryption — separate scope (S137 backup)
- Production-grade security review — pre-launch concern, not PoC
