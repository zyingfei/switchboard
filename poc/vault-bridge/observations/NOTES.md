# Vault Bridge Observations

Created: 2026-04-26

Local environment captured before manual run:

- OS: macOS 26.2, build 25C56
- Chrome binary: Google Chrome 147.0.7727.102
- Node: v25.8.2
- Extension build output: `poc/vault-bridge/extension/.output/chrome-mv3`

Automated checks run on 2026-04-26:

- `poc/vault-bridge/extension`: `npm run compile` passed
- `poc/vault-bridge/extension`: `npm test` passed, 3 tests
- `poc/vault-bridge/extension`: `npm run build` passed, total bundle 205.11 kB
- `poc/vault-bridge/reader`: `npm run compile` passed
- `poc/vault-bridge/reader`: `npm start -- --help` passed
- `poc/vault-bridge/reader`: disposable `/tmp` tail smoke passed for a normal Node append
- Tail simulation: plain `tail -f` missed an atomic replace until re-read; `tail -F` observed the replacement.
- Live Chrome/iCloud run: side panel already had `/Users/yingfei/Library/Mobile Documents/com~apple~CloudDocs/tmp` granted from the user's manual setup; tested with Computer Use.

Manual feasibility status: partial. iCloud tailing and service-worker wake writes were observed, sustained 1 Hz ticks failed around the MV3 idle window, and permission persistence showed a `prompt` state after a service-worker restart inside the same Chrome session.

## U1. Persisted Directory Handle Across Browser Restart

Outcome: Fail-risk / pending one-click re-grant check

What was tested:

- Implementation path exists: side panel calls `showDirectoryPicker({ mode: "readwrite" })`, stores the `FileSystemDirectoryHandle` in IndexedDB, and tells the service worker to reload it.
- Service worker startup path exists: `entrypoints/background.ts` calls `loadVaultHandle()` and checks read/write permission.
- Live run used the user's already-picked iCloud test vault: `/Users/yingfei/Library/Mobile Documents/com~apple~CloudDocs/tmp`.

What happened:

- The persisted handle was available to newly-started service workers at first: SW starts at `2026-04-26T10:30:45.424Z` and `2026-04-26T10:32:20.256Z` both wrote through the stored handle with `permission: granted`.
- After another service-worker restart at `2026-04-26T10:33:35.913Z`, `queryPermission({ mode: "readwrite" })` returned `prompt`. The side panel changed to `Needs grant (prompt)`, exposed `Grant stored vault`, and a manual write failed with `Vault folder permission is prompt; re-grant from the side panel.`
- I did not click `Grant stored vault` because that grants the extension access to the iCloud folder again and should be confirmed explicitly.

Evidence:

- Side panel state observed via Computer Use at `2026-04-26T10:33:35.913Z`: `Needs grant (prompt)`.
- Failed write outcome in side panel: `Vault folder permission is prompt; re-grant from the side panel.`
- Earlier successful writes from stored handle:
  - `_BAC/observations/run-20260426T103045Z.jsonl`
  - `_BAC/observations/run-20260426T103220Z.jsonl`

Browser version:

- Google Chrome 147.0.7727.102. `navigator.userAgent` in observation logs reported `Chrome/147.0.0.0`.

OS:

- macOS 26.2, build 25C56.

## U2. Service Worker Writes Through Persisted Handle After Wake

Outcome: Acceptable-with-caveat

What was tested:

- Implementation path exists: `Write test event` sends a runtime message to the service worker, and the service worker writes via the persisted handle rather than receiving a handle over extension messaging.
- The runbook includes the >=30 second idle/wake test and a side-panel-close variant.
- Live run clicked `Write test event` from the side panel while Chrome showed the extension service worker as inactive on `chrome://extensions`.

What happened:

- `Write test event` woke a service worker and wrote to the iCloud vault within one UI action.
- Successful write after SW start `2026-04-26T10:30:45.424Z`: side panel showed latency `21.3 ms`, outcome `ok`.
- Successful write after SW start `2026-04-26T10:32:20.256Z`: side panel showed latency `77 ms`, outcome `ok`.
- Caveat: if the stored handle's permission state is `prompt`, the service worker refuses to write and requires side-panel re-grant. This makes U2 dependent on U1/U5 permission behavior.

Evidence:

- Reader printed the manual event:
  `{"id":"811840f0-7795-480b-a0e0-15084c4dab05","timestamp":"2026-04-26T10:30:45.436Z","sequenceNumber":1,"payload":"synthetic","source":"manual"}`
- `_BAC/observations/run-20260426T103045Z.jsonl` recorded the event write with `latencyMs: 21.3`, `ok: true`, and `serviceWorkerState: "service-worker:activated"`.
- `_BAC/observations/run-20260426T103220Z.jsonl` recorded the event write with `latencyMs: 77`, `ok: true`, and `serviceWorkerState: "service-worker:activated"`.

Browser version:

- Google Chrome 147.0.7727.102. `navigator.userAgent` in observation logs reported `Chrome/147.0.0.0`.

OS:

- macOS 26.2, build 25C56.

## U3. `_BAC/` Append-Only Event Writes Without User-File Disturbance

Outcome: Acceptable-with-caveat

What was tested:

- Implementation writes only to `_BAC/events/<YYYY-MM-DD>.jsonl` and `_BAC/observations/run-<timestamp>.jsonl`.
- JSONL helper tests passed for daily filename and trailing-newline behavior.
- Write strategy is documented as `fsa-createWritable-keepExistingData-seek-close`.
- Live run inspected the iCloud test vault after manual writes and a short tick run.

What happened:

- The event file existed at `_BAC/events/2026-04-26.jsonl`.
- Observation logs existed under `_BAC/observations/`.
- Tail output showed complete newline-terminated JSON objects; no partial lines were observed in the short live run.
- This remains "acceptable with caveat" because the full disturbance check over a clean disposable vault and a longer concurrent read run were not completed.

Evidence:

- iCloud event file stat after the run: inode `10640140`, size `32348`, mtime `2026-04-26 03:32:28 PDT`.
- Last three event rows after the short live run were two tick rows plus one manual row, all complete JSONL:
  - sequence 29 tick at `2026-04-26T10:31:31.961Z`
  - sequence 30 tick at `2026-04-26T10:31:32.961Z`
  - sequence 1 manual at `2026-04-26T10:32:28.145Z`

Browser version:

- Google Chrome 147.0.7727.102. `navigator.userAgent` in observation logs reported `Chrome/147.0.0.0`.

OS:

- macOS 26.2, build 25C56.

## U4. Node Reader Immediate Cross-Process Consistency

Outcome: Pass for short iCloud run; long cloud-sync run still pending

What was tested:

- Reader CLI compiles and exposes `npm start -- --vault <path>`.
- Reader tails `_BAC/events/<YYYY-MM-DD>.jsonl` every 200 ms and prints complete newline-terminated JSONL records.
- Reader was run against `/Users/yingfei/Library/Mobile Documents/com~apple~CloudDocs/tmp` while the extension wrote events into the same iCloud folder.

What happened:

- CLI help path was verified.
- A disposable `/tmp` smoke appended one JSONL line from Node and the reader printed it.
- The iCloud reader printed the extension's manual write.
- The iCloud reader printed tick writes sequence 2 through sequence 30 as they arrived.
- When tick output stopped, re-reading the file showed the same last tick row. That points to the service-worker timer stopping, not a tail visibility issue, in this live run.
- A separate local simulation reproduced the user's "tail does not update, re-read shows the line" symptom with plain `tail -f` and temp-file-then-rename. `tail -F` did observe the replacement. The Node reader is path-polling, so it behaved like `tail -F` in the short iCloud run.

Evidence:

- Reader command:
  `npm start -- --vault '/Users/yingfei/Library/Mobile Documents/com~apple~CloudDocs/tmp'`
- Reader saw manual event at `2026-04-26T10:30:45.436Z`.
- Reader saw tick rows from sequence 2 at `2026-04-26T10:31:04.958Z` through sequence 30 at `2026-04-26T10:31:32.961Z`.
- No partial JSON lines were printed.
- Plain `tail -f` should not be used as U4 evidence for this write strategy; it can follow the pre-replacement inode.

Browser version:

- Google Chrome 147.0.7727.102. `navigator.userAgent` in observation logs reported `Chrome/147.0.0.0`.

OS:

- macOS 26.2, build 25C56.

## U5. Permission UX Acceptability

Outcome: Fail-risk / likely unacceptable without a re-grant design

What was tested:

- Side panel has first-run `Pick vault folder`.
- Side panel surfaces `Grant stored vault` only when the service worker reports a stored handle without granted read/write permission.
- Live run exercised normal writes, service-worker restart, and the re-grant surfacing path.

What happened:

- Permission started as `Ready (granted)`.
- After a later service-worker restart in the same Chrome session, the side panel showed `Needs grant (prompt)` and surfaced `Grant stored vault`.
- Normal capture flow was blocked until re-grant. This is not silent background capture.
- The one-click re-grant path has not been validated because I did not click the permission-grant action without explicit confirmation.

Evidence:

- Side panel at `2026-04-26T10:33:35.913Z`: `Needs grant (prompt)`.
- Side panel failed write message: `Vault folder permission is prompt; re-grant from the side panel.`

Browser version:

- Google Chrome 147.0.7727.102. `navigator.userAgent` in observation logs reported `Chrome/147.0.0.0`.

OS:

- macOS 26.2, build 25C56.

## U6. Sustained 1 Hz Service-Worker Writes

Outcome: Fail

What was tested:

- `Start tick` starts a service-worker-owned `setInterval()` that writes one synthetic event per second.
- `Stop tick` clears that timer.
- Observation logs include per-write latency and error status.
- Live run clicked `Start tick` with the side panel open and the Node reader tailing the iCloud event file.

What happened:

- Tick writes started and reached sequence 30.
- No further reader output arrived after sequence 30, and re-reading the event file showed the same last tick row.
- Clicking `Refresh` woke a new service worker with a new `swStartedAt` and reset in-memory tick state to 0.
- This fails the U6 requirement for a 60-minute 1 Hz sustained session and confirms that a service-worker-owned timer is not durable enough for sustained sync-out.

Evidence:

- `_BAC/observations/run-20260426T103045Z.jsonl` summary:
  - events: 30
  - errors: 0
  - first event: `2026-04-26T10:30:45.426Z`
  - last event: `2026-04-26T10:31:32.960Z`
  - p95 latency: `71 ms`
- Last tick event in `_BAC/events/2026-04-26.jsonl` before manual retry:
  `{"id":"da35d4c2-8440-4ef1-906b-34fe40535917","timestamp":"2026-04-26T10:31:32.961Z","sequenceNumber":30,"payload":"synthetic","source":"tick"}`
- Side panel after refresh showed new `SW started` value `2026-04-26T10:32:20.256Z` and `Tick count 0`.

Browser version:

- Google Chrome 147.0.7727.102. `navigator.userAgent` in observation logs reported `Chrome/147.0.0.0`.

OS:

- macOS 26.2, build 25C56.
