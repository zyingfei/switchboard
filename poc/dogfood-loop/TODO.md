# TODO — `poc/dogfood-loop`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **update `README.md`** to document the additional work that
> landed (the existing README covers the original PoC scope).

## Status today

This PoC's original scope is complete: see `README.md` for the proven
loop (note → fork → observe → converge → patch → persisted note) and the
in-process MCP-core JSON-RPC smoke that exposes `bac.recent_threads`,
`bac.workstream`, and `bac.context_pack`. PoC-1 was the foundation; the
remaining work for this folder is its role in the **distributed
architecture** that the later PoCs depend on.

## Remaining scope

### Contract owner role

This folder owns the **canonical MCP tool contract** that downstream PoCs
implement and consume. The shapes used by the in-process JSON-RPC smoke
become the canonical request / response schemas.

- [ ] Extract MCP tool definitions out of `src/mcp/server.ts` into a
  shared `src/mcp/contract.ts` (or equivalent) with named types per
  tool: `bac.recent_threads`, `bac.workstream`, `bac.context_pack`.
- [ ] Add `bac.search` (lexical) tool definition derived from the
  existing `src/recall/` déjà-vu spike.
- [ ] When `poc/recall-vector` lands `bac.recall` (semantic), pull its
  shape into the same contract module so all five tools live together.
- [ ] Verify no contract drift: every tool shape here matches what
  `poc/mcp-server` ships at validation time.

### Fate decisions (after dependent PoCs land)

- [ ] When `poc/obsidian-integration` ships real Obsidian writes, decide
  the fate of this folder's vault-projection code (`src/vault/`):
  remove (superseded), keep as offline-mode fallback, or refactor
  into a shared adapter.
- [ ] When `poc/mcp-server` ships real transport, decide the fate of
  the in-process MCP-core smoke (`src/mcp/server.ts`): remove
  (superseded), keep as offline / no-daemon fallback, or refactor as
  the canonical reference implementation that `poc/mcp-server` wraps.
- [ ] When `poc/recall-vector` ships semantic recall, decide the fate
  of the lexical déjà-vu spike (`src/recall/`): keep as the lexical
  half of a hybrid `bac.search`, or retire.

### Documentation

- [ ] Update `README.md` "What It Does Not Prove" section with which
  items moved to which downstream PoC, so this folder no longer claims
  ownership of unproven concerns.

## Out of scope here

- Real Obsidian writes — `poc/obsidian-integration`
- Real MCP server transport — `poc/mcp-server`
- Vector recall — `poc/recall-vector`
- Closing the real-provider live-capture gaps — `poc/provider-capture`
- Any new product surface (this folder is feature-frozen; later PoCs
  add new capability rather than evolving this one)
