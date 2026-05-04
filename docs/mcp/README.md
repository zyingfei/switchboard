# Sidetrack MCP Tools

Sidetrack exposes MCP tools through `packages/sidetrack-mcp`.

## Transports

- `stdio`: default, for clients that spawn `sidetrack-mcp`.
- `websocket`: local JSON-RPC MCP endpoint at `ws://127.0.0.1:8721/mcp`.

Start the WebSocket server:

```sh
cd packages/sidetrack-mcp
npm run build
node dist/cli.js --transport websocket --vault /path/to/vault \
  --companion-url http://127.0.0.1:17373 --bridge-key "$SIDETRACK_BRIDGE_KEY"
```

The WebSocket endpoint accepts the bridge key as `?token=<key>` or as
`Sec-WebSocket-Protocol: bearer.<key>`. If `--bridge-key` is omitted,
the WebSocket server runs without transport authentication and exposes
only vault-reader tools plus any companion-backed tools that do not need
the companion client.

## Tool Docs

Each `bac.*.md` file in this directory documents one tool's inputs,
behavior, and companion dependency.
