# M1 Demo Runbook

Status: implementation smoke runbook for the PR #13 M1 packages.

## Build and Verify

```sh
cd packages/sidetrack-companion
npm run lint && npm run typecheck && npm test && npm run build && npm run lint:openapi

cd ../sidetrack-extension
npm run lint && npm run typecheck && npm test && npm run build && npm run e2e

cd ../sidetrack-mcp
npm run lint && npm run typecheck && npm test && npm run build
```

`npm run e2e` for the extension builds the MV3 bundle and verifies the loadable manifest, side panel, background worker, and content script outputs. A real Chrome/provider manual pass is still required before calling the milestone fully accepted.

## Companion

```sh
cd packages/sidetrack-companion
npm run build
node dist/cli.js --vault /tmp/sidetrack-m1 --port 17373
```

The companion binds `127.0.0.1`, writes `/tmp/sidetrack-m1/_BAC/.config/bridge.key`, and serves:

- `GET /v1/health`
- `GET /v1/status`
- `POST /v1/events`
- `POST /v1/threads`
- `POST /v1/workstreams`
- `PATCH /v1/workstreams/:id`
- `POST /v1/queue`
- `POST /v1/reminders`

Use the bridge key value as the `x-bac-bridge-key` header. `POST /v1/events` and `POST /v1/queue` require `Idempotency-Key`.

## Extension

```sh
cd packages/sidetrack-extension
npm run build
```

Load unpacked from `packages/sidetrack-extension/.output/chrome-mv3`.

1. Open the side panel.
2. Paste the bridge key from `/tmp/sidetrack-m1/_BAC/.config/bridge.key`.
3. Keep port `17373` and select Connect.
4. Open ChatGPT, Claude, or Gemini. The content script auto-captures changed visible turns and posts them to the companion.
5. Use Track current tab on any arbitrary page, such as a GitHub PR, to create a generic fallback tracked thread.
6. Create workstreams, move tracked threads into them, queue follow-ups, toggle privacy, and reopen restorable tracked tabs.

If the companion is down, captures are queued in `chrome.storage.local` and replayed after reconnect. If a provider selector falls back, the side panel shows a provider warning.

## MCP Read Side

```sh
cd packages/sidetrack-mcp
npm run build
node dist/cli.js --vault /tmp/sidetrack-m1 --list-tools
node dist/cli.js --vault /tmp/sidetrack-m1
```

The M1 read-only tools are:

- `bac.recent_threads`
- `bac.workstream`
- `bac.context_pack`
- `bac.search`
- `bac.queued_items`
- `bac.inbound_reminders`
- `bac.coding_sessions`

The stdio integration test covers a populated `_BAC` vault fixture and verifies tool listing, context-pack output, and lexical search.

## Failure Drills

- Companion crash: stop the companion, trigger capture, restart, then refresh the side panel. Queued captures replay.
- Vault unreachable: rename `/tmp/sidetrack-m1`; `GET /v1/status` returns `vault: unreachable` and writes return `VAULT_UNAVAILABLE`.
- Provider selector drift: use a fixture/provider page with selectors missing. Capture falls back to visible text and records a selector warning.
- Closed tracked tab: close a tab with a stored `TabSnapshot`; the background marks it `restorable`, and the side panel can reopen the URL.
