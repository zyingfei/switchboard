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

`npm run e2e` for the extension builds the MV3 bundle, verifies the loadable manifest, builds the companion, then launches the extension in Playwright's bundled Chromium with a persistent temp profile. The automated pass uses the `poc/provider-capture` provider fixtures against a temp companion vault under `/tmp`; branded Google Chrome is reserved for the manual Developer Mode path below.

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

Automated MV3 validation does not side-load into a main Chrome profile. Use `npm run e2e` for Playwright-bundled Chromium coverage, and use Chrome Developer Mode → Load unpacked only for a human acceptance pass.

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

## Manual Acceptance Checklist

### Capture & tracking

- [ ] Companion starts cleanly. Verify `node dist/cli.js --vault /tmp/sidetrack-m1 --port 17373` binds `127.0.0.1`, writes `_BAC/.config/bridge.key`, and `GET /v1/health` responds within 1s.
- [ ] Extension installs and connects. Verify the unpacked MV3 build loads, the bridge key paste succeeds, and the side panel header reports the vault as connected with the companion running.
- [ ] Multi-provider capture works. Verify ChatGPT, Claude, and Gemini each produce captured events in `_BAC/events/<date>.jsonl`, then use Track current tab on an arbitrary URL and confirm the generic fallback thread lands in `_BAC/threads/<bac_id>.json`.
- [ ] Selector canary degrades safely. Verify a broken provider selector raises the yellow warning banner, offers fallback, and capture still works.
- [ ] Stop/remove tracking works. Verify per-tab stop, per-site stop, and tracked-item removal update both the side panel and the vault index.

### Organization

- [ ] Create nested workstream. Verify you can create `Sidetrack` → `MVP PRD` → `Active Work` and the tree renders in that hierarchy.
- [ ] Move tracked items without identity loss. Verify moving a thread into `Sidetrack / MVP PRD / Active Work` and then to a sibling preserves references and `bac_id`.
- [ ] Manual checklist persists. Verify adding three checklist items, checking one, closing/reopening the side panel, and restarting Chrome all preserve state.
- [ ] Tags and privacy flag render correctly. Verify adding tag `architecture`, marking the workstream `private`, and seeing masked `[private]` titles in the Workboard.

### Queue

- [ ] Queue follow-up creates the pending item. Verify adding `Ask Claude to compare with VM live migration architecture.` produces a `pending` item in both the Queued section and the workstream detail.

### Inbound reminders

- [ ] Inbound detection surfaces replies. Verify a background Claude reply appears in Inbound with the signal-orange pulse indicator, then test mark relevant or dismiss.

### Tab recovery

- [ ] Recovery dialog restores a tracked tab. Verify a closed tracked tab shows `closed (restorable)` and the reopen flow works, plus focus-open or restore-session if Chrome allows it.

### MCP read-side

- [ ] `bac-mcp` returns rich data. Verify `bac.recent_threads` returns the four captured threads, `bac.workstream({ id })` returns the nested tree with items, queued work, and checklist state, `bac.context_pack({ workstreamId })` returns a Markdown context pack, `bac.search({ query: "vm live migration" })` returns lexical matches, `bac.queued_items()` returns the pending follow-up, and `bac.inbound_reminders()` returns the Claude reply.

### Failure modes

- [ ] Chrome restart preserves state. Verify restarting Chrome reconnects the side panel to the still-running companion and capture continues.
- [ ] Companion crash and restart replays queued capture. Verify killing the companion queues a capture, then restarting replays it into the vault and returns the badge to connected.
- [ ] Vault unreachable surfaces and recovers. Verify renaming the vault triggers the error state, then restoring or re-picking it resumes capture without losing queued work.

### Standards

- [ ] Companion standards commands pass. Verify `cd packages/sidetrack-companion && npm run lint && npm run typecheck && npm test`.
- [ ] Extension standards commands pass. Verify `cd packages/sidetrack-extension && npm run lint && npm run typecheck && npm test && npm run build`.
- [ ] Extension Playwright e2e passes. Verify `cd packages/sidetrack-extension && npm run e2e`; this uses bundled Chromium, a persistent temp profile, and a temp companion vault.
- [ ] MCP standards commands pass. Verify `cd packages/sidetrack-mcp && npm run lint && npm run typecheck && npm test`.
- [ ] No `any` across production boundaries. Verify `grep -nr ": any" packages/` returns nothing in production code.
- [ ] No hidden global state. Verify composition roots still own dependency wiring and no service-locator style globals were introduced.
