# M1 test coverage — remaining work

Live-check methodology applies to every item below: **probe DOM →
write spec → observe → persist findings as unit tests if a bug
surfaces**. Reference: `docs/dev-testing.md` §"Live-check methodology".

## Status (2026-04-29)

### ✅ Done

- Side panel mounts; workboard renders.
- Queue auto-detect: pending follow-up flips to `done` when text
  appears as a user turn in a subsequent capture.
- Lifecycle pill state transitions — synthetic
  (`spec-coverage.spec.ts`) + live
  (`live-status-transitions.spec.ts`).
- Live capture against real signed-in chats
  (`live-providers-smoke.spec.ts`, all 3 providers).
- Workstream privacy modes — synthetic + live
  (`workstream-privacy.spec.ts`, `live-workstream-privacy.spec.ts`).
- Fork lineage parity — synthetic + live
  (`fork-lineage-synthetic.spec.ts`, `live-fork-lineage.spec.ts`).
- Capture extractor dedup bug — fixed; regression unit test in place
  (`tests/unit/extractors.test.ts`).

### ⏳ Remaining (codex divide-and-conquer targets)

Each item below is **independent of the others** — different feature
surfaces, different DOM subtrees, different storage keys. Safe to run
codex in parallel on each.

#### A. Dispatch-packet flow (PacketComposer)

**Scope:**
- PacketComposer template selector renders all built-in templates;
  selecting one fills the body input.
- Last-N-turns slider: changing the value updates the
  `Include last X / N turns` indicator and grows/shrinks the included
  turn count.
- Token-preview math: the displayed token count grows monotonically
  with the slider value and matches `cl100k` tokenization output.
- A successful dispatch records the packet in `RecentDispatches`.

**Files to touch:**
- `tests/e2e/dispatch-packet.spec.ts` — synthetic
- `tests/e2e/live-dispatch-packet.spec.ts` — live (gate on
  `SIDETRACK_E2E_LIVE_DISPATCH=1`)
- `tests/unit/` — only if a real bug surfaces

**Probe-first must answer:**
- Exact selectors on the PacketComposer (template buttons, body input,
  slider input, token-count display)
- The slider's actual range + step (the last codex draft used
  `setRangeValue(page, 3)` against `.slider-row` which didn't match)

**Constraints:**
- Synthetic spec uses `messageTypes.autoCapture` to seed turns; opens
  PacketComposer via the side panel UI.
- Live spec optionally drives a real chat to compare token math
  against the live tokenizer.
- Do NOT depend on a real dispatch target — the test must short-circuit
  before the actual outbound HTTP call.

#### B. Coding-attach + MCP reader handshake

**Scope:**
- "Attach coding session" UI mints a token (sidetrack stores it under
  `sidetrack.codingTokens`).
- The minted token can be presented to the MCP reader; the reader
  replies with the workstream the token was scoped to.
- Detach removes the row from the side panel and invalidates the
  token (subsequent MCP calls reject).

**Files to touch:**
- `tests/e2e/coding-attach.spec.ts` — synthetic
- `tests/e2e/live-coding-attach.spec.ts` — live (gate on
  `SIDETRACK_E2E_LIVE_CODING_ATTACH=1`)
- Possibly a new helper for spinning up the MCP reader in-process.

**Probe-first must answer:**
- The actual class names / data-testids of the CodingAttach UI
  (last codex draft used `.coding-session-row .name` which didn't
  match).
- The shape of the token storage record + how the MCP reader
  authenticates against it.

**Constraints:**
- Use `packages/sidetrack-mcp` directly via `node` — don't shell out;
  import the reader, call its tools as a function.
- Token leakage is a real concern — never log the full token; assert
  on a stable prefix or hash only.

#### C. Companion sync (vault writes + status banner)

**Scope:**
- Configuring a companion endpoint in Settings flips the SystemBanners
  state from "local-only" to "connected".
- Creating a workstream while connected writes a `.md` file with
  matching frontmatter under the configured vault root.
- Disconnecting (server killed or settings cleared) re-shows the
  "local-only" banner; subsequent mutations don't crash.

**Files to touch:**
- `tests/e2e/companion-sync.spec.ts` — synthetic
- `tests/e2e/live-companion-sync.spec.ts` — live (gate on
  `SIDETRACK_E2E_LIVE_COMPANION_SYNC=1`)
- Possibly a new helper for booting a test companion in-process.

**Probe-first must answer:**
- How `packages/sidetrack-companion` exposes its bridge — port,
  bearer-key flow, vault-path arg.
- The exact text / data-testid of the "local-only" vs "connected"
  banner element.

**Constraints:**
- Test must boot a real companion process (or in-process server) on
  an ephemeral port. **Codex sandbox cannot bind ports** — the
  synthetic-spec verification step has to happen in the user's
  CDP-connected environment, not codex's sandbox. Codex should write
  the spec, run lint + typecheck, and stop. The user (or this
  agent) runs the actual playwright check.
- Vault path: tmpdir per run, deleted on close.

#### D. Other punch-list items (lower priority — not in this batch)

- 🔧 Provider extractors against the existing fixture set —
  `extension-runtime.spec.ts` is currently skipped pending a port to
  the post-rewrite UI.
- ⏳ Search + recent déjà-vu (lexical) — verify implementation
  exists before writing tests.
- ⏳ Manual checklists — verify implementation exists.
- ⏳ Structured download / export — verify implementation exists.
- ⏳ MCP write tools with per-workstream trust — needs M2 work.
- ⏳ Tab recovery — implementation exists; needs spec.

## Methodology recap (for codex)

1. **Probe first.** Write a one-off `tests/e2e/probe-*.spec.ts` that
   opens the relevant UI and dumps DOM (selectors, classes, attrs,
   visibility). Gate on `SIDETRACK_E2E_PROBE_*=1`. Run it. Copy
   selectors into the real spec. **Delete the probe.**
2. **Drive synthetic.** Use `helpers/sidepanel.ts` →
   `seedAndOpenSidepanel()` to skip the wizard. Inject capture events
   via `messageTypes.autoCapture`. Use `{ forceLocalProfile: true }`
   so the test doesn't pollute the user's real Chrome profile.
3. **Drive live.** Mirror `live-status-transitions.spec.ts` shape:
   opt-in env var gate, `launchExtensionRuntime()` (no
   `forceLocalProfile`), capture-and-poll helpers.
4. **If live surfaces a bug**, add a unit test in `tests/unit/` that
   reproduces it from synthetic DOM, then fix the bug in `src/`.
5. **Verify before declaring done:**
   `cd packages/sidetrack-extension && npm test && npm run lint && npm run typecheck && SIDETRACK_E2E_CDP_URL=http://localhost:9222 npx playwright test <new-spec-name>`
6. **Don't commit.** Write the files; the parent agent commits
   per-feature after review.
