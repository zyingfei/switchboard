# Reproducing the real Codex-via-MCP handoff e2e

This runbook walks any operator (human or AI) through running the
end-to-end test from a fresh checkout. The companion script is
`packages/sidetrack-extension/scripts/codex-real-e2e.mjs`; the
result of a successful run is documented in
`codex-real-handoff.report.md` (alongside).

The shape of the test:

```
test browser  ──CDP──▶ extension ──HTTP──▶ companion (vault)
                                              │
                                              ▼
                                         MCP server  ◀── MCP SDK client
                                         (this script)     (this script,
                                                            playing Codex)
```

## 0. Prerequisites

Tested on macOS 14+, Apple Silicon. Linux/Windows should work the
same way; replace paths as needed.

| Dep | Version |
|---|---|
| Node.js | ≥ 22 (the runtime everything else assumes) |
| Chrome / Chromium | recent stable; needs to support `--remote-debugging-port` |
| `git` | for cloning |
| Two free TCP ports | the script uses `17373` for companion, picks a random `8730–8830` for MCP |
| ChatGPT account | the script logs into chat.openai.com via your existing browser session |

You should also have:

* A working bridge key (auto-created on first companion run; lives at
  `<vault>/_BAC/.config/bridge.key`).
* A vault directory (e.g. `~/Documents/Sidetrack-vault`); created on
  first companion start.

## 1. Build the workspace

```bash
git clone <repo>
cd <repo-root>
# Build companion (needed: dist/cli.js)
cd packages/sidetrack-companion
npm install
npm run build

# Build MCP (needed: dist/cli.js)
cd ../sidetrack-mcp
npm install
npm run build

# Build extension (needed: .output/chrome-mv3 for loading into Chrome)
cd ../sidetrack-extension
npm install
npm run build
```

## 2. Start the companion

```bash
cd packages/sidetrack-companion
node dist/cli.js --vault ~/Documents/Sidetrack-vault
```

Companion will:
- create the vault if missing,
- mint a bridge key on first run (printed once; thereafter at
  `~/Documents/Sidetrack-vault/_BAC/.config/bridge.key`),
- listen on `127.0.0.1:17373`,
- background-rebuild the recall index if model/schema changed.

Leave this running. Verify:

```bash
curl -s -H "x-bac-bridge-key: $(cat ~/Documents/Sidetrack-vault/_BAC/.config/bridge.key)" \
  http://127.0.0.1:17373/v1/system/health \
  | python3 -m json.tool | head -8
```

You should see `"status": "ok"` (eventually — recall may report
`rebuilding` while the model loads).

## 3. Start the test browser

A Chrome window with the remote-debug port open + the extension
loaded as an unpacked extension. The script's CDP attach point is
`http://localhost:9222`.

```bash
# Mac:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/sidetrack-e2e-profile \
  --load-extension=$PWD/packages/sidetrack-extension/.output/chrome-mv3 \
  &
```

(There's also `npm run e2e:chrome-debug` in
`packages/sidetrack-extension` which does the same thing if you
want a managed CFT install.)

In the test browser:
1. Navigate to chatgpt.com and log in (the script reuses the session
   to load private chat threads).
2. Open the Sidetrack side panel (toolbar icon → Sidetrack).
3. In the side panel's setup wizard, paste the bridge key from step 2.
4. Confirm the companion pill turns green and the recall index
   reports `status: ready` in the diagnostics panel.

The extension is now wired to the companion. Leave the browser
running.

## 4. Pick a target ChatGPT thread

For this runbook the target is

```
https://chatgpt.com/c/69fa10f8-ae00-8330-a104-ee21469af0e0
```

You'll want an actual chat thread you can open in your account.
The script navigates whichever chatgpt.com tab it can find to the
target URL — your session handles authentication. Edit
`TARGET_URL` near the top of `codex-real-e2e.mjs` if you want a
different thread.

## 5. Run the e2e

The driver script lives at
`packages/sidetrack-extension/scripts/codex-real-e2e.mjs`. It
imports playwright + the MCP SDK via absolute paths (no separate
`npm install` in the extension dir for this purpose).

```bash
node packages/sidetrack-extension/scripts/codex-real-e2e.mjs 2>&1 \
  | tee /tmp/codex-e2e.log
```

What happens, narrated:

| Phase | What the script does |
|---|---|
| `[1.nav]` | Connects to the test browser via CDP. Picks (or navigates) a chatgpt.com tab to the target URL. Waits for `[data-message-author-role]` to appear. |
| `[2.capture]` | Activates the target tab + window so the SW's `chrome.tabs.query({active, currentWindow})` returns it; sends `messageTypes.captureCurrentTab` from the side-panel context. Polls `chrome.storage.local` until the thread appears with a `bac_id`. |
| `[3.mcp]` | Spawns `node packages/sidetrack-mcp/dist/cli.js --transport websocket …`. Waits for the `websocket listening on …` line on stderr. |
| `[4.prompt]` | Builds the **compact handoff prompt** (now ~225 chars after the trim review). Logs the length + asserts it doesn't contain leaked URLs. |
| `[5.parse / 5.connect]` | Parses `sidetrack_thread_id` + `sidetrack_mcp` out of the prompt; opens an MCP SDK client over the WebSocket transport. |
| `[6.tools/list]` | Calls `tools/list` and logs the advertised count. |
| `[6.read_thread_md]` | Fetches the vault header markdown for the bac_id. |
| `[6.turns]` | Fetches all captured turns (the actual conversation body lives here). |
| `[6.list_dispatches]` | Fetches recent dispatches across the vault. |
| `[6.recall]` | Runs a vector recall using a snippet from the first turn. |
| `[6.list_annotations]` | Fetches user-pinned annotations. |
| `[6.queue_item]` | Writes a follow-up note back to the thread's queue. |
| `[DONE]` | Emits the queue-item bac_id; you can find the file at `<vault>/_BAC/queue/<bac_id>.json`. |

## 6. Verify evidence

After the run, four artifacts confirm correctness:

| Artifact | Where | What to check |
|---|---|---|
| Stdout log | `/tmp/codex-e2e.log` | Every step labelled `[N.subphase]`; final line `[DONE] ✓ all steps green; queue item bac_id: …`. |
| Vault header | `<vault>/_BAC/threads/<bac_id>.md` | Title resolved (`# Heap rank algorithm`), no turn body — that's expected. |
| Captured event | `<vault>/_BAC/events/YYYY-MM-DD.jsonl` (latest line for the bac_id) | `turns` array length matches the message count visible in the chat tab. |
| Queue write-back | `<vault>/_BAC/queue/<queue-bac_id>.json` | `text` field starts with `Codex e2e probe:`; `targetId` matches the thread's bac_id. |

## 7. Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `[1.nav] no chatgpt tab to navigate; user must have one logged in` | Test browser has no chatgpt.com tab open or you're not logged in | Open chatgpt.com manually + sign in. |
| `[2.capture] capture response keys: ok: undefined` | Side panel was closed when the message went out | Reopen the side panel; it must be live for the `chrome.runtime` fan-out. |
| `[2.capture] thread did not appear in local cache after 10s` | autoTrack=false + URL pattern doesn't match a thread | Check `tab.url()` ends in `/c/<id>`. The "+" capture path skips landing pages. |
| `[3.mcp] MCP server did not log listening within 8s` | Build artifact missing | `cd packages/sidetrack-mcp && npm run build` then retry. |
| `[5.connect] timed out` | MCP token didn't match `--mcp-auth-key` | The script reuses the bridge key for both; if you customised, update both flags. |
| `[6.recall] related-thread count: 0` | Recall index empty for this content | Wait for the rebuild to finish (Health panel → recall pill = ready). |
| `[6.queue_item]` throws | Companion HTTP unreachable or bridge key mismatch | Re-check companion logs + bridge.key contents. |

## 8. Adapting the script

If you want to test a different scenario, the levers are at the
top of `codex-real-e2e.mjs`:

```js
const TARGET_URL  = 'https://chatgpt.com/c/<your-thread>';
const VAULT       = '/Users/yingfei/Documents/Sidetrack-vault';
const COMPANION_PORT = 17373;
const BRIDGE_KEY  = '<paste from bridge.key file>';
const MCP_PORT    = 8730 + Math.floor(Math.random() * 100);
```

The MCP tool calls in `[6.*]` are also the canonical sequence a
new agent should walk on first connect — copy them as a template.

## 9. Companion-side gap (note)

`bac.read_thread_md` returns only the YAML header today; the
turn body lives in the event log and is exposed via `bac.turns`.
The agent flow uses both. Wiring turn bodies into the `.md`
projection is a follow-up — not blocking the demonstrated flow.
