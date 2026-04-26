# TODO v2 — `poc/mcp-server` (next iteration)

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **update `README.md`** with the v2 architecture (vault-as-
> bridge), the resolved questions, the cross-client validation results,
> and the install / packaging story for `npx bac-mcp`.
>
> The existing `poc/mcp-server/README.md` (on `main`) documents the v1
> PoC: stdio MCP server reading a static `demo-provider-captures.json`
> fixture and a `demo-vault/` fixture. v2 keeps that transport choice
> but replaces the data sources with the real production architecture.

## Status today (2026-04-26)

- v1 PoC complete on `main`: stdio MCP server with `bac.recent_threads`,
  `bac.workstream`, `bac.context_pack`, `bac.search`, `bac.recall` —
  validated against fixture `demo-vault/` + fixture provider captures.
- Two architectural principles changed since v1 was scoped:
  1. **§23.0** (BRAINSTORM) — Obsidian first-class citizen, but BAC depends
     only on interfaces and core (filesystem + Markdown + frontmatter +
     `.canvas` + `.base` + `_BAC/`). Plugins (incl. Local REST API) are
     opt-in acceleration, never required.
  2. **§27** — connection setup, sync-in, sync-out are three separate
     concepts. The MCP server consumes sync-out output (vault state); it
     does not drive sync-in or initiate writes.
- One architectural question explicitly resolved: **MCP-in-the-browser is
  not the v1 path.** Native Messaging bridge is too much install friction,
  service-worker lifetime is wrong for long sessions, and the vault
  already provides the right data substrate. v1 is `npx bac-mcp` Node
  process reading the vault from disk.

## Scope summary (one-liner)

Promote the v1 fixture-driven MCP server into a **stateless `npx bac-mcp`
package** that reads a real user vault populated by the live extension's
sync-out path, and validate the end-to-end loop (browser capture → vault
write → MCP tool call from a real coding agent) against Claude Code,
Cursor, and Codex CLI.

## Architectural questions to resolve

- **Q1.** **Vault freshness for live-state tools.** `bac.recent_threads`
  needs to know which threads are open *right now*. v1 served this from
  fixture data. v2 needs a real source. **Path:** extension flushes
  `_BAC/live/tabs.jsonl` on a tick (5–30 s) per §27 sync-out. MCP reads
  the file. **Resolves:** is bounded staleness (≤30 s) acceptable for
  every read-only tool, or do any need <5 s freshness?
- **Q2.** **`bac-mcp` install UX.** v1 PoC was workspace-internal. v2
  needs a packaging story so MCP clients can install it via standard
  one-line config (`npx bac-mcp` or `bac-mcp` from npm).
  - Sub-question: how does the user provide `--vault <path>`? Per-client
    MCP config arg, or a config file at `~/.config/bac-mcp/config.json`
    that the user edits once, or auto-detect from `_BAC/.config` in the
    cwd at launch time?
- **Q3.** **Provider-capture's storage handoff** (§27 sync-out). v1
  read fixtures. v2 needs the live extension to write captures to the
  vault as Source notes + `_BAC/events/*.jsonl` lines. This is the work
  the original `poc/provider-capture` TODO flagged but didn't resolve.
  **Resolves:** does the FileSystemAccess write path hold up under
  per-capture write rate (one append per assistant turn, plus per-tab
  state flush)?
- **Q4.** **Local REST API plugin opportunistic upgrade path.** Per
  §23.0, REST API is opt-in acceleration, never required. v2 needs to
  prove that the `VaultBinding` interface (§27) actually works with
  filesystem-only as the substrate, and surgical PATCH as a transparent
  upgrade. **Resolves:** does the abstraction hold, or does plugin
  acceleration leak into call sites?
- **Q5.** **Cross-client interoperability.** v1 was tested only via
  internal stdio harness. v2 needs real-client validation. **Resolves:**
  do all three of Claude Code, Cursor, Codex CLI install and consume the
  package with no client-specific shape mismatches?

## Pre-build gates

- [ ] Confirm `poc/provider-capture` storage handoff (§27 sync-out)
  has landed (or land it as part of this v2 work — that's where the
  capture-to-vault writer lives).
- [ ] Confirm `poc/obsidian-integration` v2 rework lands the
  FileSystemAccess primary path with REST API opportunistic accelerator
  (per §23.0). The `bac-mcp` reader does not need REST API at all (it's
  read-only on disk via Node `fs`), but the writer side does.

## Remaining scope

### Real provider → vault → MCP loop (resolves Q1, Q3)

- [ ] Replace fixture loading in `src/runtime.ts` and
  `src/readers/providerCapture.ts` with **vault-only reads**:
  - Source notes under `Projects/<project>/...` for captured content +
    promoted artifacts.
  - `_BAC/events/<date>.jsonl` for the append-only event log.
  - `_BAC/live/tabs.jsonl` for live tracked-thread state (Q1).
- [ ] Add a vault-watch / vault-scan strategy: cheapest is "read on every
  tool call" (stateless, simple); if benchmarks show this is too slow at
  scale, add an in-memory cache invalidated by mtime.
- [ ] Prove the loop end-to-end: extension captures a Gemini turn → writes
  Source note + event line → `bac.recent_threads` from a stdio harness
  call returns the captured thread within ~30 s.

### Stateless `npx bac-mcp` packaging (resolves Q2)

- [ ] Move `src/cli.ts` to a publishable shape with a real `bin` entry in
  `package.json`. Vendor minimal dependencies; tree-shake transformers.js
  (lazy-load only on `bac.recall`).
- [ ] Decide `--vault` arg shape: single `--vault <path>`, or
  config-file-discovered, or `BAC_VAULT` env var. **Decision in README at
  completion.**
- [ ] Validate the install command works on macOS / Linux / Windows. The
  cross-platform stdio behavior matters; no shell-specific assumptions.
- [ ] Document the install snippet for each MCP client (Claude Code,
  Cursor, Codex CLI) in the post-build README.

### `VaultBinding` integration test (resolves Q4)

- [ ] Build the read-side of `VaultBinding` from §27 — `bac-mcp` only
  consumes read methods (`scanForBacIds`, raw file reads). Confirm that
  the read path works identically whether the extension wrote via plain
  filesystem or via REST API PATCH (output files should be byte-identical
  ignoring timestamps).
- [ ] Add a test: dual-write fixture vault (one half written via plain
  fs, one half written via simulated PATCH). Confirm `bac.context_pack`
  returns the same shape regardless of writer path.

### Live-tab freshness (Q1 detail)

- [ ] Define the on-disk shape of `_BAC/live/tabs.jsonl`:
  ```jsonl
  {"capturedAt":"2026-04-27T12:34:56Z","tabs":[
    {"provider":"chatgpt","threadId":"...","threadUrl":"...",
     "title":"...","lastTurnAt":"...","status":"waiting_on_user"},
    ...
  ]}
  ```
  (One JSON line per flush; readers use the last line.)
- [ ] Extension-side: implement the flush tick. Default 30 s; tunable
  via side-panel setting. Skip flush if tabs unchanged.
- [ ] MCP-side: `bac.recent_threads` reads the last line; falls back to
  scanning event log if `live/tabs.jsonl` is missing or stale (>5 min).

### Audit log writes via the vault path

- [ ] v1 audit log writes to `auditLogPath` config — keep, but default
  to `_BAC/audit/<date>.jsonl` inside the vault (canonical state per
  §23.0). Same JSONL shape as v1.
- [ ] Confirm screen-share-safe mode (`screenShareSafe: true`) still
  masks per the v1 logic, just over real vault content.

### Cross-client validation (resolves Q5)

- [ ] **Claude Code**: install via `npx bac-mcp` config; run a real
  coding task that uses `bac.context_pack` to pull project context, and
  `bac.recall` for "did I research this" queries. Document setup steps.
- [ ] **Cursor**: same.
- [ ] **Codex CLI**: same.
- [ ] For each client, document: which tools were most useful, smoothness
  of setup, any shape mismatches that needed contract revision (push
  fixes back to `poc/dogfood-loop/src/mcp/contract.ts` per the canonical
  contract owner role).

### Documentation handoff

- [ ] On completion: delete this `TODO-v2.md` and update `README.md` with:
  - architecture diagram (browser → vault → bac-mcp → coding agent)
  - resolved Q1–Q5 outcomes
  - install snippet for each client
  - measured numbers: vault read latency, freshness window, cold-call
    latency for a simple `tools/list`
  - any contract revisions pushed upstream and why
  - lifetime / robustness notes for v1 productization

## Out of scope here (deferred to later iterations)

- **Live tab loopback (127.0.0.1 WebSocket)** — only build if Q1's
  "tick-to-vault" is measured insufficient. Default v1 path is the
  vault tick.
- **Sync-in (vault → BAC)** — this PoC consumes vault state; it does
  not drive vault → BAC reconciliation. That's a separate PoC that
  closes the §27 sync-in scenarios (S165, S166).
- **Inline-review tools (§28)** — `bac.review_turn` /
  `bac.submit_review_back` / `bac.dispatch_review` are post-v1 tools.
  Read-only `bac.search` over `ReviewEvent` entities is the only review
  surface that fits the v1 MCP "read-only by default" boundary.
- **Write tools** (e.g. `bac.append_decision`, `bac.mark_archived`) —
  read-only by default per v1 MCP boundary; write surface designed
  separately.
- **MCP-in-browser via Native Messaging** — explicitly rejected (see
  the "Architectural questions to resolve" preamble; install friction
  + SW lifetime + buys nothing). Reconsider only if BAC pivots to
  live-browser-automation positioning.
- **Multi-vault MCP** — single-vault binding for v1. `--vault` is
  single-valued.
- **Encrypted-backup hooks for the audit log** — separate v1 work
  (S137).
- **Cross-user / team MCP** — single-user local trust boundary only.

## Companion changes outside this folder

This iteration depends on (or naturally lands alongside) work in two
sibling PoCs. They are tracked here so the dependency is explicit, not
because the work happens in this folder.

- `poc/provider-capture/` — implement the storage handoff: every
  captured turn writes to the vault as a Source note + event log line,
  in addition to (or instead of) `chrome.storage.local`. Owns the
  source side of §27 sync-out.
- `poc/obsidian-integration/` — implement the §23.0 reframe: primary
  write path is FileSystemAccess; REST API stays as opportunistic
  accelerator behind the same `VaultBinding` interface. Owns the
  filesystem substrate for sync-out.
