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

## 3. Start the test browser (definitive)

The e2e expects a Chrome-for-Testing (CfT) window with:
- the remote-debug port open at `http://localhost:9222`,
- the unpacked Sidetrack extension loaded,
- a persistent user-data dir (so provider sign-ins survive between
  runs),
- the companion's bridge key registered with the extension.

**Use the managed script — don't hand-launch Chrome.** The script
finds the right binary, sets all four flags consistently, and writes
the extension ID to `.output/cdp-extension-id` for the spec runner.

### 3.1 One-time install of Chrome for Testing

```bash
cd packages/sidetrack-extension
npm run e2e:install-cft
```

Installs to the **shared OS cache** at
`~/Library/Caches/sidetrack/chrome-for-testing/` (one copy serves
every worktree; see `scripts/install-cft.mjs`). Override with
`SIDETRACK_CFT_ROOT` if you have a sandboxed setup.

You can prune stale per-worktree copies any time with:

```bash
npm run e2e:gc-cft           # dry-run
npm run e2e:gc-cft -- --apply
```

### 3.2 Launch

```bash
cd packages/sidetrack-extension
npm run e2e:chrome-debug
```

This runs `npm run build` then `scripts/chrome-debug.mjs`, which:

| Setting | Value | Override |
|---|---|---|
| Binary | shared CfT install | `SIDETRACK_E2E_CHROME_BIN` |
| Extension | `./.output/chrome-mv3` | `SIDETRACK_EXTENSION_PATH` |
| User-data-dir | `~/.sidetrack-test-profile` | `SIDETRACK_USER_DATA_DIR` |
| CDP port | 9222 | `SIDETRACK_E2E_CDP_PORT` |
| Initial tabs | chatgpt.com, claude.ai, gemini.google.com | (script-internal) |

The script also opens CDP, watches for the extension service worker,
and writes its ID to `.output/cdp-extension-id`. **Leave this script
running** — closing the Chrome window (Cmd-Q) stops it.

### 3.3 Sign in to providers (the **passkey** problem)

This is the step that breaks first when an agent tries to run the
e2e on a fresh machine. **chatgpt.com (Google OAuth) requires a
WebAuthn passkey** that is device-bound — Touch ID, a hardware
security key, or a phone-as-passkey. A coding agent on a remote
machine has none of these, so the OAuth flow stalls forever.

There is no fully-automatic workaround. Pick whichever applies:

**A. Human signs in once per machine** (recommended for a human
operator + agent on the same machine).

The user-data-dir at `~/.sidetrack-test-profile` persists cookies
and Google session tokens between launches. After one successful
sign-in (Touch ID at the right moment), subsequent
`npm run e2e:chrome-debug` runs reuse the session for weeks.

```bash
# On the machine that has the passkey hardware:
npm run e2e:chrome-debug
# → in the launched window, sign in to chatgpt.com / claude.ai /
#   gemini.google.com once. Cmd-Q when done.
# All later runs (including agents) skip sign-in entirely.
```

**B. Transfer a signed-in profile between machines.**

If the agent needs to run on a host that can't host a passkey, copy
the entire user-data-dir from a host that can:

```bash
# On host with the passkey (after one sign-in):
tar czf sidetrack-test-profile.tar.gz -C ~ .sidetrack-test-profile

# Transfer the tarball to the target host. Then on the target:
tar xzf sidetrack-test-profile.tar.gz -C ~
npm run e2e:chrome-debug   # cookies + session carry across
```

Caveat: Google's session-binding (device-bound credentials, DBSC)
will sometimes invalidate the moved cookies and re-prompt for the
passkey. If that happens, fall back to (A) on each host, or use (C).

**C. Use providers that don't require a hardware passkey.**

The e2e demonstrates the flow with a ChatGPT thread, but the
extension also captures from claude.ai (email magic link) and from
the OpenAI-Codex web UI. If the only obstacle is Google's passkey,
point `SIDETRACK_TARGET_URL` at a `claude.ai` thread instead — the
script will navigate there and the rest of the pipeline is identical.

```bash
SIDETRACK_TARGET_URL=https://claude.ai/chat/<id> \
  node packages/sidetrack-extension/scripts/codex-real-e2e.mjs
```

**Don't try to automate the passkey itself.** Google detects and
blocks scripted WebAuthn responses; bypassing them is bot-detection
evasion, not a fix. The user-data-dir reuse pattern above is the
sanctioned path.

If you want to script the sign-in step interactively (a window that
stays open while you complete the passkey, instead of timing out),
use:

```bash
node scripts/login-test-profile.mjs
```

This launches Playwright with the same extension and user-data-dir
as `e2e:chrome-debug`, but without the CDP port — handy because the
profile is identical and a CDP-attached run won't fight the login UI.

### 3.4 Verify the extension is loaded

A correctly-launched browser should show:

- The Sidetrack toolbar icon (puzzle-piece menu → pin Sidetrack).
- An `.output/cdp-extension-id` file in
  `packages/sidetrack-extension/` containing the 32-char extension
  ID (the script logs it as `[chrome-debug] extension id : …`).
- `curl http://localhost:9222/json/list | grep -c chrome-extension`
  returns ≥ 1 service-worker target.

If the extension is missing: re-run `npm run build` then
`npm run e2e:chrome-debug`, and confirm `.output/chrome-mv3/manifest.json`
exists.

### 3.5 Wire the bridge key (extension ↔ companion auth)

> Note: this is **not** the same as the Google passkey covered in §3.3.
> The bridge key is a per-vault token the companion uses to authenticate
> the extension. It is filesystem-readable and can be wired headlessly.

The companion mints a per-vault bridge key at startup; the extension
must hold the same key to make HTTP calls. The plumbing:

```
companion ──writes──▶ <vault>/_BAC/.config/bridge.key
                           │
                           ▼
              (you copy + paste once)
                           │
                           ▼
extension stores at chrome.storage.local["sidetrack.settings"]
                              .companion.bridgeKey
```

**Headless flow (recommended for agents):**

```bash
npm run e2e:pair
# Reads <vault>/_BAC/.config/bridge.key, writes it to
# chrome.storage.local["sidetrack.settings"].companion.bridgeKey,
# and flips sidetrack:setupCompleted=true so the wizard skips.
# Override with SIDETRACK_VAULT, SIDETRACK_COMPANION_PORT,
# SIDETRACK_E2E_CDP_URL.
```

The script also calls `/v1/system/health` and prints the resolved
status, so a successful run is its own evidence.

**Manual flow (when you have a human at the wheel):**

1. Read the key:

   ```bash
   cat ~/Documents/Sidetrack-vault/_BAC/.config/bridge.key
   ```

2. Click the Sidetrack toolbar icon to open the side panel.
3. The setup wizard asks for the bridge key on first run; paste it.
4. The companion-status pill turns green within ~2s. Recall index
   transitions to `ready` once the embedder finishes loading
   (background — first run can take ~60s on a cold model cache).

**Verify from the shell:**

```bash
KEY=$(cat ~/Documents/Sidetrack-vault/_BAC/.config/bridge.key)
curl -s -H "x-bac-bridge-key: $KEY" \
  http://127.0.0.1:17373/v1/system/health \
  | python3 -m json.tool | head -8
```

`"status": "ok"` confirms companion is running and the key is valid.

**Key drift / "401 invalid bridge key":**

- The companion regenerates the key only if `bridge.key` is missing.
  Deleting the file (e.g. fresh-vault dance) means the extension's
  stored key no longer matches — repeat the paste above.
- The extension caches the key inside `sidetrack.settings` in
  `chrome.storage.local` (nested at `companion.bridgeKey`). To clear
  it without touching the file, open DevTools on the side panel:
  ```js
  chrome.storage.local.remove('sidetrack.settings')
  ```
  Reload the side panel; the wizard re-prompts. (This also clears
  vault path + per-host overrides, so re-paste both if customised.)

There is no auto-import-from-disk path today — the paste is the
authoritative install. (The vault file is filesystem-readable and a
stray `cat` into a panel could silently swap keys.)

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
