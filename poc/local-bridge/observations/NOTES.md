# Local Bridge Observations

Created: 2026-04-26

Local environment:

- OS: macOS 26.2, build 25C56
- Chrome binary: Google Chrome 147.0.7727.102
- Node used in this run: v25.8.2
- Disposable vault: `/tmp/bac-local-bridge-live`
- Extension build output: `poc/local-bridge/extension/.output/chrome-mv3`
- Screenshot: `observations/local-bridge-connected.png`

## Q1. Install Path: HTTP and Native Messaging

Outcome: Pass for PoC

What was tested:

- Implemented HTTP localhost transport at `127.0.0.1:<port>`.
- Implemented Native Messaging stdio framing behind the same companion command surface.
- Chose HTTP as the runbook default because it can be started with `npm start -- --vault <path> --port 17875`, is easy to smoke with curl, and does not require a host manifest during PoC iteration.

What happened:

- HTTP companion started successfully on `http://127.0.0.1:17875`.
- Chrome loaded the local-bridge extension as unpacked extension ID `eiodncbfjcbdjgegbkcfgodfiiiflkkg`.
- The side panel configured against the companion with the generated key and showed `Connected`.
- Native Messaging was not installed into Chrome during this run; manifest setup is documented in RUNBOOK.md.

Evidence:

- Companion stderr: `BAC local bridge listening on http://127.0.0.1:17875`.
- Key file: `/tmp/bac-local-bridge-live/_BAC/.config/bridge.key`.
- Side panel screenshot: `observations/local-bridge-connected.png`.

## Q2. Companion Lifetime

Outcome: Pass for foreground-process v1

What was tested:

- Companion runs as a foreground Node process and logs to stderr.
- Extension reports `connected` or `disconnected / queued N`.
- Companion was killed mid-session, then restarted.

What happened:

- While the process was alive, the side panel showed `Connected`, the vault path, and companion run id `20260426T111013Z`, then `20260426T111820Z` after restart.
- After killing the process, `Refresh` showed `Disconnected / queued 0` and `Companion: Failed to fetch`.
- Restarting the process restored `Connected` without any Chrome permission grant.

Evidence:

- Killed process previously serving `17875`.
- Restart command: `npm start -- --vault /tmp/bac-local-bridge-live --port 17875`.
- Side panel after restart: `Companion http 20260426T111820Z`.

## Q3. Auth

Outcome: Pass for HTTP keyfile auth; NM documented

What was tested:

- HTTP companion generated `/tmp/bac-local-bridge-live/_BAC/.config/bridge.key`.
- Extension pasted that key into the side panel and sent it as `x-bac-bridge-key`.
- Direct unauthorized HTTP write omitted the key.
- HTTP transport rejects non-local hosts/origins before auth.

What happened:

- Unauthorized `POST /events` returned `401`.
- Authorized `POST /events` wrote `direct-1` to `_BAC/events/2026-04-26.jsonl` with `0.72 ms` latency.
- Extension-origin write with the same key wrote a synthetic manual event with `1.19 ms` latency.
- Native Messaging no longer depends on the HTTP key; its intended auth boundary is the paired Chrome native host manifest `allowed_origins`.

Evidence:

- Unauthorized smoke: HTTP `401`.
- Authorized direct event:
  `{"id":"direct-1","timestamp":"2026-04-26T11:10:25.188Z","sequenceNumber":1,"payload":"synthetic","source":"manual"}`
- Extension event:
  `{"id":"954eda94-0b0a-47a7-8cdf-6fd395141183","payload":"synthetic","sequenceNumber":1777202244233,"source":"manual","timestamp":"2026-04-26T11:17:24.234Z"}`

## Q4. Offline Queue Policy

Outcome: Pass for manual recovery path; auto-drain added after code review

What was tested:

- Queue is backed by `chrome.storage.local`.
- Queue cap is 1000 captures with oldest eviction and a dropped counter.
- Companion was killed, then the extension queued a synthetic capture while offline.
- Companion was restarted and the queue was drained.

What happened:

- Offline write changed the side-panel badge to `Disconnected / queued 1`.
- The state panel showed `1 queued / 0 dropped`.
- After companion restart, `Drain queue` replayed the queued item and cleared the queue.
- A follow-up patch makes the 3-second state poll auto-drain queued captures once the companion is reachable again.

Evidence:

- Replayed queued event:
  `{"id":"d1b8522c-8961-478f-8dbb-949bad31c052","payload":"synthetic","sequenceNumber":1777202290477,"source":"manual","timestamp":"2026-04-26T11:18:10.477Z"}`
- Replayed write observation: `latencyMs: 3.8`, `ok: true`, run `20260426T111820Z`.
- Unit tests cover chronological replay, preserving unsent captures on failure, and oldest eviction.

## Q5. End-to-End Demo and Sustained Tick

Outcome: Pass for local vault; cloud-synced rerun still pending

What was tested:

- Extension synthetic capture -> companion HTTP write -> vault JSONL.
- Existing `poc/mcp-server` stdio server pointed at the same vault and called `bac.workstream({ includeEvents: true })`.
- Companion-owned 1 Hz tick started from the extension side panel.

What happened:

- Extension capture wrote to `_BAC/events/2026-04-26.jsonl` and observation JSONL immediately.
- MCP stdio reader returned 3662 events after the sustained run; latest event had payload `synthetic`.
- Companion tick continued past the MV3 service-worker 30-second failure point observed in `poc/vault-bridge`.
- The 60-minute sustained run completed with 3659 tick events over 3664 seconds, 0 write errors, and p95 write latency `2.67 ms`.
- One max-latency outlier reached `1182.93 ms`, but the pass criterion is p95 `<100 ms`; p95 stayed well under that threshold and the companion process did not die.

Evidence:

- MCP latest event:
  `{"id":"431e9e04-7abc-425b-8bdc-bfda614e00f4","type":"unknown","payload":"synthetic","createdAt":"2026-04-26T12:20:38.927Z"}`
- Final tick summary:
  `totalEventLines: 3662`, `writes: 3662`, `tickEvents: 3659`, `errors: 0`, `p50: 1.51 ms`, `p95: 2.67 ms`, `max: 1182.93 ms`, `firstTick: 2026-04-26T11:19:01.168Z`, `lastTick: 2026-04-26T12:20:05.615Z`, `lastTickSeq: 3659`.
- Companion stop response: `tickRunning: false`, `tickSequence: 3659`, run id `20260426T111820Z`.
- The companion process remained alive throughout and the side panel continued to show `Connected`.

## Deferred Cloud-Synced Variant

The iCloud-specific tail issue from `poc/vault-bridge` was not rerun yet against
the companion. The companion writes through Node `fs.open(..., "a")`, so plain
`tail -f` inode replacement issues from the FileSystemAccess temp-file path are
not expected on event JSONL. This still needs a direct iCloud / Dropbox /
OneDrive rerun before calling Q5 complete for cloud vaults.
