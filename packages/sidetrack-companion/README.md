# @sidetrack/companion

The Bun process that owns the Sidetrack vault and serves its localhost
API. The extension is sensor + UI; the companion is the only writer;
the MCP server is read-only. (BRAINSTORM §27.6.)

## Run

```bash
bun run build                                   # tsc → dist/
bun dist/cli.js --vault ~/sidetrack-vault --port 17373
```

`bun dist/cli.js --help` lists every flag. It can also install itself
as a background service (`--install-service`) and spawn the sibling
MCP server (`--mcp-port`). Full setup: [`../../INSTALL.md`](../../INSTALL.md).

## Scripts

| Command | What it does |
|---|---|
| `bun run build` | `tsc -p tsconfig.build.json` → `dist/` |
| `bun run test` | Vitest suite |
| `bun run typecheck` / `lint` / `format:check` | Static checks |
| `bun run start` | `bun dist/cli.js` (pass `--vault` / `--port`) |

## What it does

- **HTTP API** (`src/http/`) — versioned `/v1/*` routes, bridge-key
  auth (`x-bac-bridge-key`). Liveness is `/v1/status`; identity is
  `/v1/version`.
- **Recall search** (`src/recall/`, `src/search/`, `src/page-content/`)
  — Unified Content Search: a shared analyzer feeds a lexical
  (MiniSearch) + vector (e5 embeddings) hybrid, fused by reciprocal
  rank fusion, over captured chat turns and page content.
- **Connections graph** (`src/connections/`, `src/materializers/`) —
  a materializer derives visits, similarity edges, and topics from
  the event log.
- **Page evidence** (`src/page-evidence/`) — per-URL content features
  feeding the recall pool and suggestions.
- **MCP** (`src/mcp/`) — spawns the read-only `sidetrack-mcp` server
  when `--mcp-port` is set.
- **Sync** (`src/sync/`) — optional end-to-end-encrypted relay; the
  vault event log is causal-first (see
  [`docs/adr/0002`](../../docs/adr/0002-causal-first-sync.md)).

## Vault

All Sidetrack-owned files live under `<vault>/_BAC/` — events log,
threads, workstreams, recall index, page-evidence/content, connections
snapshots, config (`_BAC/.config/bridge.key`). Never write outside
`_BAC/`. Stable `bac_id`s are identity; file paths are projections.

## Conventions

Read [`../../AGENTS.md`](../../AGENTS.md) and
[`../../CODING_STANDARDS.md`](../../CODING_STANDARDS.md) first. HTTP
surfaces follow [`../../standards/01-api-component.md`](../../standards/01-api-component.md);
MCP work follows [`../../standards/02-mcp-components.md`](../../standards/02-mcp-components.md).
