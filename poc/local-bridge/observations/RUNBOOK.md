# Local Bridge Runbook

Created: 2026-04-26

This runbook replays the vault-bridge U-tests against the companion architecture
and adds Q1-Q5 checks for install UX, lifetime, auth, offline queueing, and
end-to-end read composition.

## Prerequisites

- macOS with Google Chrome developer mode enabled.
- Node 22+.
- A disposable local vault, for example `/tmp/bac-local-bridge-live`.
- Optional cloud-synced vault variant: iCloud Drive, Dropbox, or OneDrive.

## Steps

1. Build and test the companion:
   `cd poc/local-bridge/companion && npm install && npm run compile && npm test`.
2. Build and test the extension:
   `cd poc/local-bridge/extension && npm install && npm run compile && npm test && npm run build`.
3. Start the HTTP companion:
   `cd poc/local-bridge/companion && npm start -- --vault /tmp/bac-local-bridge-live --port 17875`.
4. Record the generated key from `/tmp/bac-local-bridge-live/_BAC/.config/bridge.key`.
5. Load `poc/local-bridge/extension/.output/chrome-mv3` from `chrome://extensions` as an unpacked extension.
6. Open `chrome-extension://<extension-id>/sidepanel.html`, keep transport as `HTTP localhost`, keep port `17875`, paste the bridge key, and click `Use pasted key`.
7. Confirm Q2/Q3: the badge changes to `Connected`, `Companion` shows the run id, and an unauthorized HTTP write without `x-bac-bridge-key` returns `401`.
8. Click `Write test event`; confirm `_BAC/events/<YYYY-MM-DD>.jsonl` gains one complete JSONL row and `_BAC/observations/run-*.jsonl` records an ok outcome.
9. Confirm Q4: stop the companion, click `Write test event`, observe `Disconnected / queued 1`; restart the companion and confirm the queued item drains in chronological order.
10. Confirm Q5 read composition: point `poc/mcp-server` at the same vault and call `bac.workstream({ includeEvents: true })`; the latest synthetic event should appear within about 5 seconds.
11. Confirm Q5 sustained tick: click `Start tick`, let the companion run for 60 minutes if possible, then click `Stop tick`; summarize count, errors, and p95 latency from `_BAC/observations/run-*.jsonl`.
12. Repeat steps 3-11 against one cloud-synced vault path, for example `/Users/<you>/Library/Mobile Documents/com~apple~CloudDocs/tmp`, and document any read latency or sync-specific tailing caveats.

## Native Messaging Setup Sketch

HTTP localhost is the default for this runbook because it has the simplest
`npm start` install story and makes auth behavior inspectable with curl. The NM
path is still implemented for comparison.

For macOS Native Messaging, create a host manifest similar to:

```json
{
  "name": "com.browser_ai_companion.local_bridge",
  "description": "BAC local bridge companion",
  "path": "/absolute/path/to/local-bridge-host-shim",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<extension-id>/"]
}
```

Install it at:

`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.browser_ai_companion.local_bridge.json`

The shim should run:

`node /absolute/path/to/poc/local-bridge/companion/src/cli.ts --vault /path/to/vault --nm`

Windows uses a registry key under
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_ai_companion.local_bridge`.
Linux uses
`~/.config/google-chrome/NativeMessagingHosts/com.browser_ai_companion.local_bridge.json`.
