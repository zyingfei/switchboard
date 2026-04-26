# Local Bridge PoC

This PoC is the pivot after `poc/vault-bridge`: the Chrome extension is now only
the browser sensor and queue owner, while a foreground Node companion owns all
vault writes and sustained work.

## What Changed

`poc/vault-bridge` proved that the filesystem path itself works, but MV3 service
worker lifetime and FileSystemAccess permission state make silent long-running
capture unreliable. `poc/local-bridge` moves the writer role into a local
companion process:

```text
Extension side panel/background -> HTTP localhost or Native Messaging -> companion -> vault/_BAC/events/*.jsonl
```

The vault remains the canonical bridge. The companion writes plain files under
`_BAC/`; no Obsidian plugin, Native Messaging-only path, or local REST plugin is
required.

## Install Path (Q1)

Both transports are implemented:

- HTTP localhost: default for this PoC, `127.0.0.1:<port>`, API key in
  `x-bac-bridge-key`.
- Native Messaging: stdio length-prefixed JSON frames with Chrome manifest
  capability as the intended auth boundary.

HTTP is the runbook default because it has the smallest v1 install story:

```sh
cd poc/local-bridge/companion
npm install
npm start -- --vault /tmp/bac-local-bridge-live --port 17875
```

Then load `poc/local-bridge/extension/.output/chrome-mv3` in
`chrome://extensions`, paste the key from
`/tmp/bac-local-bridge-live/_BAC/.config/bridge.key`, and click
`Use pasted key`.

For a mostly hands-off verification run:

```sh
cd poc/local-bridge
npm run verify
```

Useful variants:

```sh
npm run verify -- --tick-seconds 60
npm run verify -- --vault "/Users/$USER/Library/Mobile Documents/com~apple~CloudDocs/tmp" --tick-seconds 60
npm run verify -- --no-browser --tick-seconds 10
```

The default verifier starts a companion, checks auth, writes events, runs a
short companion tick, probes whether `tail -f` sees a sentinel event, stops the
companion to verify outage behavior, restarts it, and prints a PASS/FAIL
summary. Add `--no-tail` to skip the tail probe. Add `--browser` to also try
driving the unpacked extension through Chrome DevTools Protocol; that path
depends on Chrome accepting command-line unpacked-extension loading in the
temporary profile. Temporary Chrome profiles are left in `/tmp` rather than
deleted for you.

## Companion Lifetime (Q2)

The companion is a foreground Node process for v1. It logs to stderr and stops
with Ctrl-C or SIGTERM. Auto-start via launchd/systemd/Task Scheduler is out of
scope for this feasibility pass.

The side panel surfaces:

- `Connected`
- `Disconnected / queued N`
- queue count
- companion run id
- vault path
- tick state
- last write latency

Killing the companion mid-session made the side panel show `Failed to fetch`;
restarting the same command restored `Connected` without any browser permission
prompt.

## Contract And Auth (Q3)

HTTP message shapes:

```http
GET  /health
GET  /status
POST /events       { id, timestamp, sequenceNumber, payload: "synthetic", source }
POST /tick/start   { intervalMs? }
POST /tick/stop    {}
```

Authenticated HTTP routes require:

```http
x-bac-bridge-key: <contents of _BAC/.config/bridge.key>
```

The companion binds to `127.0.0.1` and rejects non-local hosts/origins. Key
rotation is manual for the PoC: delete `_BAC/.config/bridge.key`, restart the
companion, and paste the new key into the side panel.

Native Messaging uses the same logical commands over stdio. Its intended auth is
Chrome's paired native-host manifest `allowed_origins`, not the HTTP key.

## Offline Queue (Q4)

The extension stores captures in `chrome.storage.local` before sending. Replay is
chronological. The queue is capped at 1000 items; when full, oldest captures are
evicted and the dropped counter increments so the side panel can warn instead of
silently losing data.

Observed recovery:

- Companion killed.
- Extension write changed badge to `Disconnected / queued 1`.
- Companion restarted.
- Queue drained back to `0 queued / 0 dropped`; replayed write latency was
  `3.8 ms`.

## Evidence (Q5)

Validated on macOS 26.2 and Chrome 147.0.7727.102.

Build/test checks:

```sh
cd poc/local-bridge/companion && npm run compile && npm test
cd poc/local-bridge/extension && npm run compile && npm test && npm run build
```

End-to-end checks:

- Direct authorized HTTP write landed in `_BAC/events/2026-04-26.jsonl`.
- Extension side-panel `Write test event` landed in the same JSONL file with
  `1.19 ms` observed latency.
- Existing `poc/mcp-server` stdio reader returned the companion-written event
  stream via `bac.workstream({ includeEvents: true })`; latest returned payload
  was `synthetic`.
- Companion tick completed a 60-minute local-vault run: `3659` tick events over
  `3664` seconds, `0` errors, p50 latency `1.51 ms`, p95 latency `2.67 ms`.
  There was one max-latency outlier at `1182.93 ms`, but the p95 pass criterion
  stayed far below `100 ms` and the process did not die.

This confirms the companion architecture resolves vault-bridge U6 for the local
vault path. The cloud-synced iCloud / Dropbox / OneDrive variant is still a
separate rerun before claiming full cloud-vault behavior.

## Vault-Bridge Failures Resolved

The companion architecture resolves the specific vault-bridge failures:

- U5/FileSystemAccess prompt risk: extension no longer needs write permission to
  the vault; HTTP uses a keyfile and NM uses a manifest capability.
- U6/service-worker timer death: sustained ticks run in the Node companion, not
  in an MV3 service worker.

The remaining product cost is install complexity: v1 needs an extension plus a
foreground companion process.

## Next `poc/mcp-server` Re-Scope

Keep `bac-mcp` read-only and separate from the writer for the next iteration,
but teach it the raw local-bridge event shape directly instead of mapping these
events to `type: "unknown"`. The next `poc/mcp-server` pass should expose a small
`bac.recent_events` or equivalent read tool that can page `_BAC/events/*.jsonl`
by timestamp/id, while leaving write ownership exclusively in the companion.

## BRAINSTORM Follow-Ups

- §26.6 Path B should be treated as the v1 writer architecture, not a fallback.
- §27 should explicitly name extension queue replay as part of sync-out setup,
  separate from vault sync-in and MCP read composition.
- Productization needs an installer/foreground companion story before any claim
  of "silent capture after reboot."
