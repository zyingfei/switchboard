# §13 Acceptance-Demo Runbook (2026-07-11)

Execution runbook for the PRD §13 16-step acceptance scenario.

> **[2026-07-17 UI refresh]** Re-verified against **main @ `83020925`**
> after the **Private Ledger** redesign (R1/R1.1/R1.2), the
> **conversation-loop** wave, and the inbound read-semantics change.
> Click-paths and some expected visuals moved; **zero testids were
> renamed and every capability is still reachable**. Every edited step
> carries a `[2026-07-17 UI refresh]` delta note; the original
> `f09057ec` deltas are preserved. Where the design specs and the code
> disagreed, **code won** — those cases are called out inline.

This reflects what the UI **actually does today**, not the PRD's
original wording — where they differ, it's called out as **DELTA
(expected — not a failure)**.

**How to use:** walk the steps in order. Each is `DO → EXPECT → IF IT
BREAKS`. Record a screen capture. Mark each step pass / fail / amended.
Steps 12 and 15 are terminal-only (not browser clicks) — I can run those
halves for you; say the word.

**Nav crib (post-redesign — read once before you start):** the old flat
7-tab bar is gone. The header now has **two rows**: Row A is the
**Capture Lamp strip** (lamp glyph + current domain + capture verdict +
the master-capture eye); Row B is the **5-section nav** — **Now · Work ·
Inbox · Library · Privacy** — plus the visible capture tools (search,
find-active-tab, screenshare-mask, attach-coding, capture-mode) and, on
the far right, the **⚙ gear** (Settings) and the **connect-dot** (vault
+ companion + recall health). Each section reveals its own **sub-tabs**:
**Work** → Threads / Workstreams / Queued; **Inbox** → Replies / Inbox;
**Library** → Search / Explore. (Design-spec note: the redesign doc
§4.4 predicted the sections would be named *Now/Work/Memory/Trust/
Settings* and that find/screenshare/coding would hide in `⋯` — **the
shipped code named them Now/Work/Inbox/Library/Privacy, kept Settings as
a gear, and R1.2 returned the daily tools to the visible toolbar**. This
runbook follows the code.)

The one real gap the original verification found (step 8, recovery modal
unreachable) is **already fixed**; the recovery modal is reached via the
per-row **↗ "Open thread tab"** button.

---

## Pre-flight setup

Run these on your rig (you hold the keyboard). All against the **test**
instance (:17374 / `~/.sidetrack-vault-test`) — never the daily vault.

> **[2026-07-17 UI refresh] Current companion restart recipe** — the
> `run-test-companion.sh` script now boots the whole test rig, so the
> restart is just *quit screen → kill the listener → relaunch under
> screen*:
> ```bash
> screen -S sidetrack-companion-test -X quit 2>/dev/null
> pkill -9 -f 'cli.js.*17374'
> sleep 2
> cd /Users/yingfei/playground/playground/browser-ai-companion
> screen -dmS sidetrack-companion-test zsh -lc './scripts/run-test-companion.sh'
> ```
> `kill -9` is safe (recovery.ts reclaims the lock). The screen session
> keeps the companion alive across the whole demo. **Never** touch
> ports 17373 / 9222 (daily vault + Chrome debug on other rigs).

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
(Run this **from `packages/sidetrack-extension`** with `~/.bun/bin` on
PATH — that's the CfT + `~/.sidetrack-test-profile` browser, auto-paired
to the test companion on :17374. Reloading the extension rebuilds it
with today's redesigned panel.)

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

> **[2026-07-17 UI refresh] Where the §15 freeze-lift counters live** —
> the §15 acceptance-criteria rail renders **live** inside the Health
> panel (`hp-section15`, header **"§15 freeze-lift · X/6 met"`,
> `HealthPanel.tsx`). Reach it two ways: **⚙ gear → Settings →
> Diagnostics → "Open capture health"**, or the **⋯ overflow →
> "Capture health"**. Counter values are companion-supplied (the panel
> only renders what `/v1/system/section15` returns), so they update as
> you run the demo. **Currently 2/6 met** — running this §13 demo
> cleanly is what earns the rest. (This is the §15 window we open after
> a clean-or-amended 16/16.)

---

## The 16 steps

### Step 1 — open the four surfaces
**DO:** open tabs for a ChatGPT thread, a Claude thread, a Google search, and start a Codex CLI session. As you focus each web tab, glance at the **Capture Lamp strip** (top of the panel, Row A).
**EXPECT:** four surfaces live; Google is a normal page, Codex is in a terminal. On each web tab the lamp strip shows that tab's **eTLD+1 domain** (mono) + a capture verdict: **"Recording this page"** (lamp glyph ● filled, warm accent) when capture is on and the site isn't blocked.
**IF IT BREAKS:** if the verdict reads **"Capture paused — everywhere"** (amber), the master eye is off — click the **eye** in the lamp strip (`capture-toggle`) to resume. If it reads **"Not captured — rule: `<label>`"** (rose) the site has a no-capture rule; that's a per-site block, not a failure.
**[2026-07-17 UI refresh]** Capture state now lives in **one place** — the always-visible lamp strip (`capture-lamp-strip`: domain `capture-lamp-domain`, verdict `capture-lamp-verdict`, eye `capture-toggle`) — replacing the old scattered eye + card-badge + status-pill scan. Verdict strings verified in code: `Recording this page` / `Capture paused — everywhere` / `Not captured — rule: <label>` (App.tsx). This is the redesign's headline privacy fix — a capture change now retints the whole panel and is announced (`role=status aria-live=polite`).

### Step 2 — auto-track the AI tabs + manually track the search
**DO:** focus the ChatGPT and Claude tabs (auto-track fires); on the Google tab, click the **`+` / "Track current tab"** affordance in the panel.
**EXPECT:** the two AI threads appear without action; the search appears after the click.
**IF IT BREAKS:** the manual `+` button is hidden when auto-track is ON — toggle capture mode to Manual, or use the "Track current tab →" link in an empty workstream. If "Capture is paused" appears, turn the capture eye back on. Auto-track has a 30s per-URL cooldown, so don't rapid-reload.
**[2026-07-17 UI refresh]** The `+` (capture-current-tab) button lives in the **visible toolbar** (Row B, inside `capture-tools`) and, unchanged, **only renders when capture mode is Manual** — when the mode toggle shows **AUTO**, the `+` is hidden (nothing to do). To manually track the search either flip the capture-mode toggle to **MANUAL** (the ✋ icon in Row B) then click `+`, or open **Work → Workstreams**, enter a workstream with no threads, and click the **"Track current tab →"** link in its empty state (App.tsx:8436). The eye (now in the lamp strip) still gates all capture; the `+` is disabled while paused.

### Step 3 — see all four tracked items
**DO:** click the **Work** section (Row B nav), then the **Threads** sub-tab.
**EXPECT:** threads grouped into lifecycle buckets (Replied · unread / Ungrouped / Waiting on AI / Stale or closed / Normal).
**DELTA (expected):** the view is labeled **"Threads"**, not "Active work", and groups by lifecycle bucket, not by workstream. The **Codex session appears as a separate coding-session row**, not a thread. That's current design, not a failure.
**[2026-07-17 UI refresh]** Threads is now **Work → Threads** (the `Threads` sub-tab under the **Work** section; `section-nav-work` → sub-tab aria-name "Threads", viewMode `all`). The top lifecycle bucket is now worded **"Replied · unread"** (unified with the Inbox copy per the conversation-loop wave), replacing the old "Unread reply" label — same underlying signal, verified in code. Capability and buckets are otherwise unchanged.

### Step 4 — queue two follow-ups
**DO:** on a thread's menu, click **Queue follow-up**, type an ask, Enter; repeat. Then open **Work → Queued**.
**EXPECT:** both asks listed, grouped under the thread. Each queued row shows the item text (2-line clamp) plus, **when the item can't ship, a blocker line and an [Open]/[Send now] pair** (also [Edit] and [Remove]).
**Sub-step (blocker + Open):** **close the thread's tab**, return to **Work → Queued**, and confirm the row reads **"The chat tab is closed."** with an **[Open]** button. Click **[Open]** — the tab reopens and, if auto-send is on, the item sends; otherwise the redacted text is placed on the clipboard for you to paste (see step 10 note). Empty queue reads **"Nothing queued yet."** (verified copy).
**DELTA (expected):** the queue UI is **thread-scoped only** — there's no selector to queue "into the workstream." Queue into the thread; it's the same object. **This is now the intended design, not a polish gap** — the workstream/global scope options were removed in the conversation-loop wave.
**[2026-07-17 UI refresh]** Queued is now **Work → Queued** (`Queued` sub-tab, aria-name "Queued follow-ups", viewMode `queued`). Row anatomy verified in `QueuedView.tsx`: **[Open]**, **[Send now]**, **[Edit]**, **[Remove]** with a per-row **blocker line** (`The chat tab is closed.` etc.). This **strengthens** the step — it now has a real blocker/[Open] acceptance criterion (moved from "Partial by design" to "should pass cleanly"). Step 4 no longer counts as partial.

### Step 5 — create the nested workstream
**DO:** go to **Work → Workstreams**, open the workstream picker, create **MVP PRD**, then create **Active Workstreams** nested under it.
**EXPECT:** a 3-level tree Sidetrack → MVP PRD → Active Workstreams.
**IF IT BREAKS:** the picker is modal — trigger it from the workstream selector on the **Workstreams** sub-tab. Create the parent first, then the child under it (creating on-the-fly during a *move* makes a top-level workstream instead — see step 6).
**[2026-07-17 UI refresh]** The Workstreams surface is now **Work → Workstreams** (`Workstreams` sub-tab, viewMode `workstream`); the picker modal and its `ws-picker-row` rows are unchanged.

### Step 6 — move the four items into the nested workstream
**DO:** on each of the 3 AI threads + the search, menu → **Move to workstream…**, pick **Active Workstreams**.
**EXPECT:** each item moves under Active Workstreams; the count increments.
**IF IT BREAKS:** if "Active Workstreams" doesn't exist yet, the inline-create here makes it **top-level** — create it via step 5 first so the move targets the nested one.
**[2026-07-17 UI refresh]** The **Move to workstream…** item and the `MoveToPicker` modal are unchanged; you reach the threads from **Work → Threads**. Nav path only.

### Step 7 — add + tick a checklist
**DO:** from **Work → Workstreams**, open the **workstream detail** for Active Workstreams, scroll to **Checklist**, add three items, then tick them.
**EXPECT:** items render with checkboxes + a "0/3 done" counter that increments; ticked items get strikethrough.
**IF IT BREAKS:** the checklist only renders inside the workstream **detail panel** — make sure you opened detail (not just the row).
**[2026-07-17 UI refresh]** The `WorkstreamDetailPanel` modal (with `ChecklistPanel`) is unchanged; it now opens from the **Work → Workstreams** sub-tab. No control renames.

### Step 8 — recover the closed Claude tab  ✅ *(fixed)*
**DO:** in **Work → Threads**, close the Claude tab. Its row shows **"Tab closed · Xm"**. Click the **↗ reopen arrow** on that row (aria-label **"Open thread tab"**).
**EXPECT:** the **recovery modal** opens (**"Reopen this tab?"**) with strategy buttons **"Focus open tab"** / **"Restore from session history"** / **"Reopen URL"**, and a "Will run: …" line. Pick one; the tab reopens.
**IF IT BREAKS:** this was the one unreachable path — now wired to the ↗ button (not the whole row). If the modal doesn't appear, confirm the browser was relaunched after setup (the fix ships via the wxt rebuild). Session-restore needs `chrome.sessions` to still hold the closed tab; otherwise it falls back to reopen-URL.
**[2026-07-17 UI refresh]** The row lives under **Work → Threads**; the ↗ button's aria-label is **"Open thread tab"** and the `TabRecovery` modal strategy labels verified in code are **"Focus open tab" / "Restore from session history" / "Reopen URL"** (`TabRecovery.tsx`). No behavior change.

### Step 9 — Inbound "replied N minutes ago"
**DO:** open the **Inbox** section (Row B nav) — it defaults to the **Replies** sub-tab.
**EXPECT:** reply cards, each with a **provider chip** + **thread title** + **age** on the top line, a **context line** ("`<workstream>` · in reply to …") when a prompt/dispatch can be joined, an optional **one-line reply snippet**, an unread dot, and the actions **[Open]** and **[Dismiss]** — **only those two** ("Mark relevant" is gone).
**Also verify the handshake (one event, two views):** when a fresh reply is captured, the **same** thread's row in **Work → Threads** flips to **"Replied · unread"** *and* the **Inbox** nav badge (`section-nav-badge-inbox`) increments — one reminder, two views. Reading it in **either** place (Open in the card, or Open on the thread chip) marks it read and clears **both**.
**IF IT BREAKS / SETUP DEPENDENCY:** a reminder only appears after a **real new assistant turn** lands on a tracked thread and the companion captures it. To force it: send a message in the tracked Claude/ChatGPT thread, wait for the reply, let the panel poll (~15s). Empty Replies reads **"No new replies waiting. When an AI answers a tracked thread, it lands here."** (not a bug — no reply arrived yet).
**[2026-07-17 UI refresh]** Renamed/moved: the old **Inbound** tab is now **Inbox → Replies** (viewMode `inbound`; the **Inbox** section also has an **Inbox** sub-tab for ambient backlog). Design-spec note: the redesign doc placed this under **Trust → Replies**; the **shipped code put it under the Inbox section** — this runbook follows the code. Card anatomy + **Open/Dismiss-only** (Mark-relevant removed) and the **Replied · unread ⇄ Inbox-badge handshake** verified in `InboundCard.tsx` / `InboundView.tsx` / App.tsx. The acceptance bar is unchanged, plus the handshake is now an explicit thing to confirm.

### Step 10 — inline review → dispatch out
**DO:** in a thread (from **Work → Threads**), select a span of an assistant turn, click **Review**, set verdict **Partial**, comment, click **Dispatch to other AI…**, confirm.
**EXPECT:** the dispatch appears in **Recent dispatches** (under the **Now** section) as source-thread → Claude.
**DELTA (expected):** the review dispatch target is **hard-bound to Claude** — there's no retarget picker in the confirm modal. Matches the PRD if "→ Claude" is read literally.
**[2026-07-17 UI refresh]** Mechanics unchanged; **Recent Dispatches** is now under the **Now** section. Redaction note: the conversation-loop **Queued [Open] → paste fallback** (step 4) writes its clipboard text through the *same* `preflightOutbound(...).safeText` primitive this step exercises, but via a **direct redacted clipboard write, not the `DispatchConfirm` modal** — so if step 11's redaction passes, the Queued paste lane inherits the same **redaction** guarantee (you don't need to re-test redaction for it), though it does **not** exercise the DispatchConfirm review UI.

### Step 11 — Research Packet from cluster + queued asks (the redaction step)
**DO:** open the packet composer (`PacketComposer` modal — unchanged), choose **Ask another AI → GPT Pro**, tick the two **queued asks**, review the body, click **Copy to clipboard**. (To exercise redaction, include an email or a fake `sk-...`/`AKIA...` string in a captured turn.)
**EXPECT:** ticked asks render as a **## Questions** section; token estimate shows; if a secret/email is present, a redaction chip fires; the **copied** text is the **redacted** body. Toast: "Packet copied (NNNN tokens)".
**VERIFIED SAFE:** the copy path routes through `preflightOutbound` (App.tsx:4116 — `preflightOutbound(packet.body, …).safeText`) — it ships the redacted/scrubbed body, never raw. Paste into a scratchpad and confirm the secret is `[redacted]`.
**[2026-07-17 UI refresh]** SAFETY-CRITICAL and unchanged by the redesign — `PacketComposer` / `DispatchConfirm` / `SafetyChainSummary` modals keep their copy + testids. Only the code line moved (copy preflight is now `App.tsx:4116`, re-verified). Do not weaken this step.

### Step 12 — Coding Agent Packet → Claude Code
**DO:** in the composer, choose **Hand to a coding agent → Claude Code** (the composer is reached from the **attach-coding-session** toolbar icon or the packet composer).
**EXPECT:** body is a coding handoff pointing at `sidetrack_mcp: http://127.0.0.1:8721/mcp` + `Bearer <key>` + the thread id.
**DELTA (expected):** it's not a verbose AGENTS.md dump — the packet *is* the minimal MCP-handoff. **Needs the MCP server from setup D running on :8721**, else the handoff endpoint is dead. *(Terminal check — I can verify the endpoint answers.)*
**[2026-07-17 UI refresh]** The coding-attach entry point is the **visible toolbar icon** `attach-coding-session` (aria-label "Attach coding session"), **not** the `⋯` menu — R1.2 returned the daily tools to the toolbar (the redesign doc's "moved into ⋯" note is stale; code wins). The `CodingAttach` modal itself is unchanged. If the companion isn't connected, the button routes to the setup wizard instead of dead-ending.

### Step 13 — export to the vault tree path
**DO:** in the **workstream detail** (opened from **Work → Workstreams**), click **Export to vault**.
**EXPECT:** a file at a path derived from the workstream's parent chain, e.g. `Sidetrack/MVP-PRD/Active-Workstreams/<title>-report1.md`, **outside** `_BAC/`; the panel lists the written path; re-exporting increments `-report2`, etc.
**DELTA (expected):** the path is **derived from your actual workstream titles** (sanitized), not the literal PRD example. Confirm on disk: `ls ~/.sidetrack-vault-test/Sidetrack/` (or wherever your tree lands).
**[2026-07-17 UI refresh]** Unchanged control: **Export to vault** button in `WorkstreamDetailPanel.tsx` (class `ws-detail-export-btn`); the written paths are surfaced back in the panel. Path derivation + `-reportN` increment live in the companion (`/v1/workstream/export`), not the panel. Only the entry point moved to **Work → Workstreams**.

### Step 14 — open the vault in Obsidian
**DO:** open `~/.sidetrack-vault-test` in Obsidian; open a workstream `.md`. (In-panel recall for the same content lives under **Library → Search**.)
**EXPECT:** YAML frontmatter (bac_id, revision, kind, title, privacy, screenShareSensitive) + a `## Checklist` section rendering `[x]/[ ]` items.
**DELTA (expected):** **Bases/Canvas dashboards do NOT exist yet** (deferred to a follow-up PR). Step 14 passes on frontmatter + markdown + checklist rendering; don't look for the Canvas/Bases views.
**[2026-07-17 UI refresh]** The Obsidian check is unchanged. The panel's Search/recall surface (if you want to cross-check) is now **Library → Search** (viewMode `search`) with an **Explore** sub-tab alongside; the search internals + all `connections-*`/`focus-*`/`flow-*` testids are untouched. There's also a quick **Search** icon in Row B.

### Step 15 — MCP context_pack round-trip
**DO:** against the setup-D server, call the tool `sidetrack.workstreams.context_pack` with `{ workstreamId: "<the MVP-PRD or Active-Workstreams id>" }`.
**EXPECT:** a Markdown Context Pack with Workstreams / Checklist / Threads / Queued Asks sections + a generatedAt stamp — the same data the panel shows.
**DELTA (expected):** command is **`sidetrack-mcp` + `sidetrack.workstreams.context_pack`** (not `bac-mcp`/`bac.context_pack`); auth is `--mcp-auth-key`. A bad/missing key → the streamable-http server refuses to start. *(Terminal step — I can run the whole round-trip and hand you the output.)*
**[2026-07-17 UI refresh]** Terminal-only, no panel path — the redesign doesn't touch this. If you want to confirm the same data in the UI, the workstream detail (Work → Workstreams) shows the equivalent sections.

### Step 16 — screen-share masking
**DO:** click the **screenshare-mask toggle** in the visible toolbar (Row B, `screenshare-mask`). Look at thread titles whose workstream is `private` (or `screenShareSensitive`).
**EXPECT:** those titles render as **`[private]`**; others stay normal.
**DELTA (expected):** masking is a **manual toggle + per-workstream flag** — there is **no auto-detect** of an OS screen-share (the PRD amended auto-detect to P1). So you flip the toggle yourself; it won't fire automatically when you start a real screen-share.
**[2026-07-17 UI refresh]** The mask control is a **visible toolbar icon** (`screenshare-mask`, aria-label "Toggle screenshare mode", `aria-pressed` reflects state) — R1.2 kept it on the toolbar for daily demo/streaming use; it is **not** in the `⋯` menu (the redesign doc's "moved to ⋯" note is stale; code wins). Masking behavior + the `[private]` render are unchanged.

---

## Scorecard summary (what to expect)

- **Should pass cleanly:** 1, 2, 3\*, 4\*, 5, 6, 7, 8, 10\*, 11, 13\*, 14\*, 16\* — where \* means "passes, but read the DELTA so you don't count the amended behavior as a failure."
- **Setup-dependent:** 9 (needs a real reply to arrive), 12 & 15 (need the MCP server on :8721).
- **Partial by design:** *(none — step 4 graduated to "should pass cleanly" now that thread-scope is spec and the blocker/[Open] affordance is the new acceptance criterion).*

**[2026-07-17 UI refresh]** Step 4 moved from "Partial by design" → "should pass cleanly" (conversation-loop wave: thread-scope is now the intended design and the blocker line + [Open]/[Send now] are the acceptance criteria). Step 9 gained the **Replied · unread ⇄ Inbox-badge handshake** as an explicit check. All nav paths follow the shipped **Now / Work / Inbox / Library / Privacy + ⚙ gear** IA (code, not the redesign doc's predicted Now/Work/Memory/Trust/Settings).

Log each result; for anything that breaks beyond these known deltas,
send me the step + what you saw and I'll turn it into a scoped fix.
After a clean-or-amended 16/16, record the run and we start the §15
window — the freeze-lift counters (**currently 2/6 met**) render live in
**⚙ Settings → Diagnostics → Open capture health** (`hp-section15`,
"§15 freeze-lift · X/6 met").
