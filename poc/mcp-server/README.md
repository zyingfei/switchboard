# MCP Server POC

This POC promotes the in-process BAC MCP smoke path into a standalone local
MCP server in `poc/mcp-server/`.

The implementation deliberately chooses:

- Host process: standalone Node process
- Transport: `stdio`
- Trust boundary: local subprocess only, read-only tools only

That is the simplest cross-client path for Claude Code and Codex CLI, and it
avoids the lifetime and auth complexity of an always-on localhost daemon for
this first moat-test.

## What It Wires Together

The server consumes the other POCs through their existing data shapes and
helpers:

- `poc/provider-capture`
  - reads provider-capture JSON snapshots
  - drives `bac.recent_threads`
  - contributes captured assistant output, prompt runs, and source artifacts
- `poc/obsidian-integration`
  - reads an Obsidian-shaped local vault
  - drives the current note, related source notes, and `_BAC/events/*.jsonl`
- `poc/dogfood-loop`
  - provides the canonical `bac.*` tool contract
  - provides Context Pack generation and lexical déjà-vu search helpers
- `poc/recall-vector`
  - provides vault-corpus loading and calibrated-freshness recall ranking

## Tool Surface

The standalone server exposes:

- `bac.recent_threads`
- `bac.workstream`
- `bac.context_pack`
- `bac.search`
- `bac.recall`

All tools are read-only.

## Layout

```text
fixtures/
  demo-config.json           sample server config
  demo-provider-captures.json
  demo-vault/                sample Obsidian-shaped corpus
src/
  cli.ts                     stdio entrypoint
  server.ts                  MCP SDK tool registration
  runtime.ts                 PoC composition layer
  readers/                   provider-capture + vault readers
  recallRuntime.ts           semantic recall bridge
tests/
  stdio.test.ts              end-to-end stdio integration test
```

## Config

The server reads a JSON config file:

```json
{
  "vaultPath": "./demo-vault",
  "providerCapturesPath": "./demo-provider-captures.json",
  "project": "SwitchBoard",
  "currentNotePath": "Projects/SwitchBoard/MCP discussion.md",
  "auditLogPath": "../.data/demo-audit-log.jsonl",
  "screenShareSafe": false,
  "embedder": {
    "kind": "hashing",
    "device": "wasm"
  }
}
```

Notes:

- `vaultPath` points at the Obsidian-shaped root directory.
- `providerCapturesPath` points at a JSON array of provider captures.
- `screenShareSafe` masks URLs, emails, and token-like strings in tool output.
- `embedder.kind` defaults to `hashing` for fast deterministic local tests.
- You can switch to `"transformers"` for a more realistic recall path; that will
  download and use the same Hugging Face model family as `poc/recall-vector`.

Environment overrides are also supported:

- `BAC_VAULT_PATH`
- `BAC_PROVIDER_CAPTURES_PATH`
- `BAC_PROJECT`
- `BAC_CURRENT_NOTE_PATH`
- `BAC_AUDIT_LOG_PATH`
- `BAC_SCREEN_SHARE_SAFE`
- `BAC_EMBEDDER_KIND`
- `BAC_EMBEDDER_DEVICE`

## Security Boundary

- `stdio` only: no listening port, no localhost socket, no bearer token layer
  needed for this PoC
- read-only tool surface
- local file reads constrained to the configured vault root and capture JSON
- per-tool audit logging to `.data/*.jsonl`
- optional screen-share-safe masking

This is intentionally a smaller boundary than the future localhost-daemon path.
The point here is interoperability first.

## Run

```sh
cd poc/mcp-server
npm install
npm run compile
npm test
npm run build
npm run smoke -- --config ./fixtures/demo-config.json
```

## What Passed Locally

Validated on April 26, 2026:

- `npm run compile`
- `npm test`
- `npm run build`
- `npm run smoke -- --config ./fixtures/demo-config.json`
- real `codex exec` run against the MCP server over stdio

The smoke client verified:

- tool registration over real MCP stdio transport
- `bac.recent_threads`
- `bac.workstream`
- `bac.context_pack`
- `bac.search`
- `bac.recall`

I also checked real registration commands in disposable configs:

- `claude mcp add --transport stdio ...` connected successfully
- `codex mcp add ...` registered successfully and showed up in `codex mcp list`
- `codex exec` successfully called `bac.recent_threads`, `bac.context_pack`, and
  `bac.recall` once the Codex-side MCP approval mode was forced to `approve`

Important nuance:

- I did not run an interactive live coding session inside Claude Code or Codex
  CLI from this environment.
- The server behavior is validated end to end through:
  - the MCP SDK smoke client
  - the stdio integration test
  - a real non-interactive `codex exec` session
- A plain unattended `codex exec` run will cancel MCP tool calls unless the MCP
  server config sets `default_tools_approval_mode = "approve"` or the user
  approves the calls interactively.

## Manual Verify: Claude Code

From the repo root:

```sh
export BAC_MCP_ROOT="$(pwd)/poc/mcp-server"
claude mcp add --transport stdio --scope project bac-mcp -- \
  node "$BAC_MCP_ROOT/dist/cli.js" \
  --config "$BAC_MCP_ROOT/fixtures/demo-config.json"
```

Then in Claude Code:

1. Run `/mcp` and confirm `bac-mcp` is connected.
2. Ask: `Use bac.recent_threads and summarize the latest two threads.`
3. Ask: `Use bac.context_pack and tell me the current goal.`
4. Ask: `Use bac.recall with query "browser-owned mcp server" and cite source paths.`

Expected signals from the fixture corpus:

- recent threads include Claude, Gemini, and ChatGPT captures
- the Context Pack starts with `# BAC Context Pack`
- recall returns `Projects/SwitchBoard/Validation notes.md` and
  `Projects/SwitchBoard/MCP discussion.md` near the top

## Manual Verify: Codex CLI

From the repo root:

```sh
export BAC_MCP_ROOT="$(pwd)/poc/mcp-server"
codex mcp add bac-mcp -- \
  node "$BAC_MCP_ROOT/dist/cli.js" \
  --config "$BAC_MCP_ROOT/fixtures/demo-config.json"
```

Useful checks:

```sh
codex mcp list
```

Then inside an interactive `codex` session:

1. Run `/mcp` and confirm `bac-mcp` is present.
2. Ask the same three prompts used in the Claude Code section.

For unattended non-interactive validation with `codex exec`, add this config
override so Codex auto-approves calls from this MCP server:

```sh
codex exec \
  -c 'mcp_servers.bac-mcp.command="node"' \
  -c 'mcp_servers.bac-mcp.args=["'"$BAC_MCP_ROOT"'/dist/cli.js","--config","'"$BAC_MCP_ROOT"'/fixtures/demo-config.json"]' \
  -c 'mcp_servers.bac-mcp.default_tools_approval_mode="approve"' \
  -C "$(pwd)" \
  --skip-git-repo-check \
  'Use bac.recent_threads with limit 2, then bac.context_pack, then bac.recall with query "browser-owned mcp server" and topK 2.'
```

Observed result in the April 26, 2026 validation:

- `bac.recent_threads(limit=2)` succeeded
- `bac.context_pack()` succeeded
- `bac.recall(query="browser-owned mcp server", topK=2)` succeeded
- top recall source paths were:
  - `Projects/SwitchBoard/Validation notes.md`
  - `_BAC/events/2026-04-26.jsonl#L1`

## Why `stdio` Won

For this PoC, `stdio` beats a localhost daemon because it:

- works naturally with both target clients
- avoids daemon lifecycle and keep-alive questions
- keeps the trust boundary simpler
- makes setup a single command instead of a background service plus token flow

If the product later needs always-on shared state across many clients, a
localhost transport is still a valid next experiment. This build is the
interoperability-first cut.
