# §13 Acceptance-Demo Runbook (2026-07-11)

Execution runbook for the PRD §13 16-step acceptance scenario, verified
against the **current build** (post-audit-drive, main @ `f09057ec` +
`fix/tab-recovery-modal-wiring`). This reflects what the UI **actually
does today**, not the PRD's original wording — where they differ, it's
called out as **DELTA (expected — not a failure)**.

**How to use:** walk the steps in order. Each is `DO → EXPECT → IF IT
BREAKS`. Record a screen capture. Mark each step pass / fail / amended.
Steps 12 and 15 are terminal-only (not browser clicks) — I can run those
halves for you; say the word.

The one real gap the verification found (step 8, recovery modal
unreachable) is **already fixed** on this branch; the browser relaunch
in setup picks it up.

---

## Pre-flight setup

Run these on your rig (you hold the keyboard). All against the **test**
instance (:17374 / `~/.sidetrack-vault-test`) — never the daily vault.

**A. Rebuild + restart the test companion on today's code:**
```bash
cd /Users/yingfei/playground/playground/browser-ai-companion/packages/sidetrack-companion
../../node_modules/.bin/tsc -p tsconfig.build.json          # emit fresh dist/
screen -S sidetrack-companion-test -X quit 2>/dev/null; pkill -9 -f 'cli.js.*17374'; sleep 2
cd /Users/yingfei/playground/playground/browser-ai-companion
screen -dmS sidetrack-companion-test zsh -lc './scripts/run-test-companion.sh'
```
(`kill -9` is safe — recovery.ts reclaims the lock. The screen session
keeps it alive across the demo.)

**B. Launch the test browser (rebuilds the extension, incl. the step-8 fix):**
```bash
cd /Users/yingfei/playground/playground/browser-ai-companion/packages/sidetrack-extension
PATH="$HOME/.bun/bin:$PATH" bun run e2e:chrome-debug
```

**C. Verify pairing:** in a scratch terminal,
```bash
curl -s -H "x-bac-bridge-key: $(cat ~/.sidetrack-vault-test/_BAC/.config/bridge.key)" \
  http://127.0.0.1:17374/v1/version
```
Expect `instanceLabel:"test"` and today's `codePath`. Open the side panel
(extension icon) — header should show **vault connected** + **companion
running** (green dots).

**D. (For steps 12 & 15) start the MCP server** in its own terminal:
```bash
cd /Users/yingfei/playground/playground/browser-ai-companion/packages/sidetrack-mcp
../../node_modules/.bin/tsc -p tsconfig.build.json
node dist/cli.js --vault ~/.sidetrack-vault-test --transport streamable-http \
  --port 8721 --mcp-auth-key "$(cat ~/.sidetrack-vault-test/_BAC/.config/mcp.key 2>/dev/null || cat ~/.sidetrack-vault-test/_BAC/.config/bridge.key)"
```
(The coding-agent packet in step 12 points at `127.0.0.1:8721`; step 15
calls this server.) — I can run this and the round-trip for you.

---

## The 16 steps

### Step 1 — open the four surfaces
**DO:** open tabs for a ChatGPT thread, a Claude thread, a Google search, and start a Codex CLI session.
**EXPECT:** four surfaces live; Google is a normal page, Codex is in a terminal.
**IF IT BREAKS:** n/a (setup).

### Step 2 — auto-track the AI tabs + manually track the search
**DO:** focus the ChatGPT and Claude tabs (auto-track fires); on the Google tab, click the **`+` / "Track current tab"** affordance in the panel.
**EXPECT:** the two AI threads appear without action; the search appears after the click.
**IF IT BREAKS:** the manual `+` button is hidden when auto-track is ON — toggle capture mode to Manual, or use the "Track current tab →" link in an empty workstream. If "Capture is paused" appears, turn the capture eye back on. Auto-track has a 30s per-URL cooldown, so don't rapid-reload.

### Step 3 — see all four tracked items
**DO:** click the **Threads** tab.
**EXPECT:** threads grouped into lifecycle buckets (Unread reply / Ungrouped / Waiting on AI / Stale or closed / Normal).
**DELTA (expected):** the view is labeled **"Threads"**, not "Active work", and groups by lifecycle bucket, not by workstream. The **Codex session appears as a separate coding-session row**, not a thread. That's current design, not a failure.

### Step 4 — queue two follow-ups
**DO:** on a thread's menu, click **Queue follow-up**, type an ask, Enter; repeat. Then open the **Queued** tab.
**EXPECT:** both asks listed, grouped under the thread.
**DELTA (expected):** the queue UI is **thread-scoped only** — there's no selector to queue directly "into the workstream" as the PRD wording implies. Queue into the thread; it's the same object. (Flagged as a P0 polish item; not blocking.)

### Step 5 — create the nested workstream
**DO:** open the workstream picker, create **MVP PRD**, then create **Active Workstreams** nested under it.
**EXPECT:** a 3-level tree Sidetrack → MVP PRD → Active Workstreams.
**IF IT BREAKS:** the picker is modal — trigger it from the workstream selector. Create the parent first, then the child under it (creating on-the-fly during a *move* makes a top-level workstream instead — see step 6).

### Step 6 — move the four items into the nested workstream
**DO:** on each of the 3 AI threads + the search, menu → **Move to workstream…**, pick **Active Workstreams**.
**EXPECT:** each item moves under Active Workstreams; the count increments.
**IF IT BREAKS:** if "Active Workstreams" doesn't exist yet, the inline-create here makes it **top-level** — create it via step 5 first so the move targets the nested one.

### Step 7 — add + tick a checklist
**DO:** open the **workstream detail** for Active Workstreams, scroll to **Checklist**, add three items, then tick them.
**EXPECT:** items render with checkboxes + a "0/3 done" counter that increments; ticked items get strikethrough.
**IF IT BREAKS:** the checklist only renders inside the workstream **detail panel** — make sure you opened detail (not just the row).

### Step 8 — recover the closed Claude tab  ✅ *(fixed on this branch)*
**DO:** close the Claude tab. Its row shows **"Tab closed · Xm"**. Click the **reopen arrow** (↗) on that row.
**EXPECT:** the **recovery modal** opens ("Reopen this tab?") with strategy buttons (focus-open / restore-session / reopen-URL). Pick one; the tab reopens.
**IF IT BREAKS:** this was the one unreachable path — now wired to the ↗ button (not the whole row). If the modal doesn't appear, confirm the browser was relaunched after setup (the fix ships via the wxt rebuild). Session-restore needs `chrome.sessions` to still hold the closed tab; otherwise it falls back to reopen-URL.

### Step 9 — Inbound "replied N minutes ago"
**DO:** open the **Inbound** tab (header, near Inbox/Queued).
**EXPECT:** rows like "Claude replied 3 minutes ago" with Open / Mark relevant / Dismiss.
**IF IT BREAKS / SETUP DEPENDENCY:** a reminder only appears after a **real new assistant turn** lands on a tracked thread and the companion captures it. To force it: send a message in the tracked Claude/ChatGPT thread, wait for the reply, let the panel poll (~15s). Empty Inbound = "No new replies waiting" (not a bug — no reply arrived yet).

### Step 10 — inline review → dispatch out
**DO:** select a span of an assistant turn, click **Review**, set verdict **Partial**, comment, click **Dispatch to other AI…**, confirm.
**EXPECT:** the dispatch appears in **Recent dispatches** (Now tab) as source-thread → Claude.
**DELTA (expected):** the review dispatch target is **hard-bound to Claude** — there's no retarget picker in the confirm modal. Matches the PRD if "→ Claude" is read literally.

### Step 11 — Research Packet from cluster + queued asks (the redaction step)
**DO:** open the packet composer, choose **Ask another AI → GPT Pro**, tick the two **queued asks**, review the body, click **Copy to clipboard**. (To exercise redaction, include an email or a fake `sk-...`/`AKIA...` string in a captured turn.)
**EXPECT:** ticked asks render as a **## Questions** section; token estimate shows; if a secret/email is present, a redaction chip fires; the **copied** text is the **redacted** body. Toast: "Packet copied (NNNN tokens)".
**VERIFIED SAFE:** the copy path routes through `preflightOutbound` (App.tsx:4184) — it ships the redacted/scrubbed body, never raw. Paste into a scratchpad and confirm the secret is `[redacted]`.

### Step 12 — Coding Agent Packet → Claude Code
**DO:** in the composer, choose **Hand to a coding agent → Claude Code**.
**EXPECT:** body is a coding handoff pointing at `sidetrack_mcp: http://127.0.0.1:8721/mcp` + `Bearer <key>` + the thread id.
**DELTA (expected):** it's not a verbose AGENTS.md dump — the packet *is* the minimal MCP-handoff. **Needs the MCP server from setup D running on :8721**, else the handoff endpoint is dead. *(Terminal check — I can verify the endpoint answers.)*

### Step 13 — export to the vault tree path
**DO:** in the workstream detail (or "Save as reference"), click **Export to vault**.
**EXPECT:** a file at a path derived from the workstream's parent chain, e.g. `Sidetrack/MVP-PRD/Active-Workstreams/<title>-report1.md`, **outside** `_BAC/`; the panel lists the written path; re-exporting increments `-report2`, etc.
**DELTA (expected):** the path is **derived from your actual workstream titles** (sanitized), not the literal PRD example. Confirm on disk: `ls ~/.sidetrack-vault-test/Sidetrack/` (or wherever your tree lands).

### Step 14 — open the vault in Obsidian
**DO:** open `~/.sidetrack-vault-test` in Obsidian; open a workstream `.md`.
**EXPECT:** YAML frontmatter (bac_id, revision, kind, title, privacy, screenShareSensitive) + a `## Checklist` section rendering `[x]/[ ]` items.
**DELTA (expected):** **Bases/Canvas dashboards do NOT exist yet** (deferred to a follow-up PR). Step 14 passes on frontmatter + markdown + checklist rendering; don't look for the Canvas/Bases views.

### Step 15 — MCP context_pack round-trip
**DO:** against the setup-D server, call the tool `sidetrack.workstreams.context_pack` with `{ workstreamId: "<the MVP-PRD or Active-Workstreams id>" }`.
**EXPECT:** a Markdown Context Pack with Workstreams / Checklist / Threads / Queued Asks sections + a generatedAt stamp — the same data the panel shows.
**DELTA (expected):** command is **`sidetrack-mcp` + `sidetrack.workstreams.context_pack`** (not `bac-mcp`/`bac.context_pack`); auth is `--mcp-auth-key`. A bad/missing key → the streamable-http server refuses to start. *(Terminal step — I can run the whole round-trip and hand you the output.)*

### Step 16 — screen-share masking
**DO:** click the **screenshare toggle** in the panel top bar. Look at thread titles whose workstream is `private` (or `screenShareSensitive`).
**EXPECT:** those titles render as **`[private]`**; others stay normal.
**DELTA (expected):** masking is a **manual toggle + per-workstream flag** — there is **no auto-detect** of an OS screen-share (the PRD amended auto-detect to P1). So you flip the toggle yourself; it won't fire automatically when you start a real screen-share.

---

## Scorecard summary (what to expect)

- **Should pass cleanly:** 1, 2, 3\*, 5, 6, 7, 8, 10\*, 11, 13\*, 14\*, 16\* — where \* means "passes, but read the DELTA so you don't count the amended behavior as a failure."
- **Setup-dependent:** 9 (needs a real reply to arrive), 12 & 15 (need the MCP server on :8721).
- **Partial by design:** 4 (queue is thread-scoped; no workstream-scope UI).

Log each result; for anything that breaks beyond these known deltas,
send me the step + what you saw and I'll turn it into a scoped fix.
After a clean-or-amended 16/16, record the run and we start the §15 window.
