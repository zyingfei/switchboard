# Vault Bridge Manual Runbook

This runbook is intentionally manual because the unknowns depend on Chrome's native folder picker, persisted File System Access handles, MV3 service-worker lifetime, and cloud-sync filesystem behavior.

## Setup

1. Install and build the extension:

   ```sh
   cd poc/vault-bridge/extension
   npm install
   npm run compile
   npm test
   npm run build
   ```

2. Install the reader:

   ```sh
   cd poc/vault-bridge/reader
   npm install
   npm run compile
   ```

3. Create a disposable local vault folder, then start the reader:

   ```sh
   mkdir -p /tmp/bac-vault-bridge-local
   cd poc/vault-bridge/reader
   npm start -- --vault /tmp/bac-vault-bridge-local
   ```

   Use this Node reader for U4 rather than plain `tail -f`. File System Access writes may replace the visible file on close, and plain `tail -f` can keep following the old file descriptor. If using shell tools, prefer `tail -F`.

4. Load the extension in Chrome:
   - Open `chrome://extensions`.
   - Enable Developer mode.
   - Load unpacked: `poc/vault-bridge/extension/.output/chrome-mv3`.
   - Open the extension side panel, or open `chrome-extension://<extension-id>/sidepanel.html`.

## Twelve Manual Steps

1. In the side panel, click `Pick vault folder` and select `/tmp/bac-vault-bridge-local`.
   - Covers U1 first grant and U5 initial permission UX.
   - Capture a screenshot of the selected/ready side panel.

2. Click `Write test event`.
   - Covers U2 initial service-worker write and U3 `_BAC/events` creation.
   - Confirm the reader prints one complete JSONL line within 1 second.
   - Confirm the vault contains `_BAC/events/<YYYY-MM-DD>.jsonl` and `_BAC/observations/run-*.jsonl`.

3. Inspect the written files:
   - Confirm only `_BAC/events/` and `_BAC/observations/` were created.
   - Confirm the event line ends in a newline and parses as JSON.
   - Confirm the observation line includes `latencyMs`, `ok`, `browserVersion`, and `serviceWorkerState`.

4. Leave Chrome idle for at least 30 seconds without clicking the side panel.
   - Picked 30 seconds because Chrome's MV3 service workers are commonly terminated after roughly this idle window.

5. After the idle period, click `Write test event` again.
   - Covers U2 event-driven wake.
   - Pass only if a new JSONL line appears within 1 second and no permission prompt blocks the write.

6. Close the side panel, wait 30 seconds, reopen it, and click `Write test event`.
   - Covers the side-panel-to-woken-service-worker path without an already-open panel keeping the worker warm.

7. Quit Chrome completely, reopen Chrome with the same profile, open the side panel, and click `Write test event`.
   - Covers U1 persisted handle after browser restart and U5 restart UX.
   - If the panel shows `Grant stored vault`, click it once and retry. Record whether this was one-click or a full folder picker.

8. Reboot the machine if practical, reopen Chrome, and click `Write test event`.
   - Covers the strongest U1/U5 normal-usage persistence variant.
   - If not practical, mark this step skipped with reason.

9. Create a cloud-synced test vault in one of iCloud Drive, Dropbox, or OneDrive.
   - Example: `~/Library/Mobile Documents/com~apple~CloudDocs/bac-vault-bridge-cloud`.
   - Start a second reader against that folder.
   - Pick that folder in the side panel and click `Write test event`.
   - Covers U4 cloud-synced read consistency.

10. With the cloud reader running, click `Write test event` five times at human speed.
    - Confirm the Node reader prints each complete line within 1 second.
    - Confirm it never prints partial JSON.

11. For U6, pick the local test vault again, click `Start tick`, and leave Chrome running for 60 minutes.
    - Keep the reader running.
    - Do not rely on side-panel polling as a keepalive; refresh manually only when recording status.
    - At the end, click `Stop tick`.

12. Compute U6 latency and error evidence from the observation log:

    ```sh
    node -e "const fs=require('fs');const p=process.argv[1];const rows=fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.kind==='event');const l=rows.map(r=>r.latencyMs).sort((a,b)=>a-b);const p95=l[Math.floor(l.length*.95)]??0;console.log({events:rows.length,errors:rows.filter(r=>!r.ok).length,p95});" /tmp/bac-vault-bridge-local/_BAC/observations/run-*.jsonl
    ```

    - Pass U6 only if 60 minutes completes, there are no errors, p95 is under 100 ms, and the service worker did not stop producing tick events.

## Evidence To Attach

- Side panel screenshot after first folder pick.
- Side panel screenshot after browser restart.
- Terminal screenshot or clip showing the Node reader tailing lines.
- Finder or terminal listing showing only `_BAC/events` and `_BAC/observations`.
- Observation log path and summary stats.
- Chrome version, OS version, and cloud-sync provider/version if used.
