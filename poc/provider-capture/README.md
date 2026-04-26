# Provider Capture POC

This is the second POC under `poc/`. It focuses on the hardest browser-plugin capability after the dogfood loop: capturing visible content from an already-open provider tab and keeping the artifact local.

The intent here is narrow on purpose. We are not automating prompts or building sync. We are proving that a Chrome extension can recognize an existing ChatGPT, Claude, or Gemini tab, extract the visible conversation-shaped content conservatively, and persist that artifact in local extension storage for later workflow use.

## What This POC Proves

- A WXT + React + MV3 extension can detect capture-ready ChatGPT, Claude, Gemini, and fixture tabs.
- The extension can capture visible conversation-oriented text from the active tab without screenshots.
- Captures are stored only in `chrome.storage.local` in the current browser profile.
- The side panel can show the active tab, stored captures, selector-canary status, warnings, and turn-by-turn preview.
- A selector canary can run on capture-ready tab load, keep local-only health counters, and surface a clipboard fallback when a provider DOM drifts.
- A tracked-thread registry can expose `getTrackedThreads(filter?)` for the future `bac.recent_threads` MCP reader without leaking storage details.
- Provider-specific selectors can be tested automatically with fixture pages.
- The extraction logic can be refined against real provider DOM drift and locked in with regression tests.

## What We Implemented

- `entrypoints/background.ts`
  - background coordinator for active-tab detection, capture requests, and local persistence
- `entrypoints/content.ts`
  - content-side bridge for visible-text extraction from the current page
- `entrypoints/sidepanel/*`
  - side panel UI with:
    - active tab summary
    - `Capture active tab`
    - local capture history
    - capture preview with warnings and per-turn source labels
- `src/capture/providerDetection.ts`
  - provider detection for ChatGPT, Claude, Gemini, and local fixtures
- `src/capture/extractors.ts`
  - visible-text extractors with provider-aware selectors plus conservative fallback
- `src/background/storage.ts`
  - local storage wrapper around `chrome.storage.local`
- `src/registry/trackedThreads.ts`
  - tracked-thread reader interface plus local selector-health counters
- `fixtures/provider-pages/*.html`
  - local provider-like pages for automated extension tests

## Privacy And Security Posture

- Local-only storage via `chrome.storage.local`
- No backend
- No cloud sync
- No screenshots
- No cookies or `localStorage` reads
- No hidden input reads
- No scraping of draft prompt boxes or private form values
- Visible-content extraction only, using conversation-oriented selectors first and a conservative fallback second

This stays aligned with the security-first direction of the project and leaves room for local encryption on top later.

## Automated Test Approach

This follows the TechPulse testing shape:

- `Vitest` for typed unit coverage around the extraction and storage primitives
- `Playwright` for extension e2e against local provider fixtures
- built MV3 output loaded into Chrome with the extension under test
- extension exercised through its actual side/content/background boundaries rather than isolated UI mocks

Current automated coverage includes:

- provider detection
- visible-text extraction for ChatGPT-like, Claude-like, and Gemini-like DOM
- hidden-text exclusion
- form-control exclusion
- storage append/read behavior
- redaction warnings
- Gemini live-like regression coverage for heading blocks and editable-panel content
- signed-in DOM-shaped ChatGPT and Claude regression fixtures derived from real captures
- tracked-thread registry and selector-health counter coverage
- extension e2e proving capture and persistence across reload with local fixture pages

## Commands

```sh
cd poc/provider-capture
npm install
npm run compile
npm test
npm run build
npm run e2e:install
npm run test:e2e
```

Notes:

- `npm test` runs the unit suite.
- `npm run test:e2e` builds the extension and runs the Playwright extension harness.
- The e2e runner uses Chrome for Testing when available and can be pointed at another Chrome binary with `BAC_E2E_CHROME_PATH`.

## Live Validation Summary

On April 25, 2026, we also validated the POC collaboratively in the user's normal Chrome profile, because passkey-based provider logins were not reliable in Chrome for Testing.

What was proven live:

- ChatGPT signed-in conversation-thread capture worked on a real `https://chatgpt.com/c/<id>` page.
- ChatGPT project-thread capture also worked on a real `https://chatgpt.com/g/.../c/<id>` page.
- Claude signed-in conversation-thread capture worked on a real `https://claude.ai/chat/<id>` page after moving Claude to a heading-based structural fallback.
- Gemini signed-in conversation capture worked in the real browser session.
- Gemini capture now includes visible assistant turns and large editable/canvas output, not only user prompts.

### Gemini Extraction Improvement

During live Gemini testing, the first pass was too shallow. It captured only a small slice of the page:

- before: `7 turns / 664 chars`

We then strengthened the Gemini extractor in `src/capture/extractors.ts` and the inline fallback path to handle:

- heading-based blocks such as `You said` and `Gemini said`
- visible editable/canvas content that Gemini renders alongside the conversation

After that patch, the same live capture became:

- after: `15 turns / 23,570 chars`

That was the most important refinement in this POC so far, because it proves we can respond to real provider DOM shape rather than only passing fixture tests.

### ChatGPT And Claude Live-DOM Lock-In

The April 25, 2026 live passes also closed the remaining signed-in gaps for ChatGPT and Claude:

- ChatGPT's normal thread DOM already matched `main [data-message-author-role]` cleanly, so we locked a sanitized regression fixture around the real `conversation-turn-*` plus `data-message-author-role` structure.
- Claude's real DOM did not expose a durable assistant-message selector. The stable path was the hidden heading pattern (`You said:` / `Claude responded:`), so the extractor now scores structural candidates against direct-selector candidates instead of stopping after the first direct user-only hit.
- Both real DOM shapes now have committed sanitized fixtures under `fixtures/provider-pages/` to catch silent provider redesign drift in unit tests.

## Tracked Thread Contract

This POC now owns the reader contract that will feed the future `bac.recent_threads` MCP tool:

```ts
interface TrackedThread {
  provider: 'chatgpt' | 'claude' | 'gemini' | 'unknown';
  threadId: string;
  threadUrl: string;
  title: string;
  lastTurnAt: string;
  captureCount: number;
  status: 'active' | 'waiting_on_user' | 'waiting_on_ai' | 'stale' | 'fallback';
}
```

`src/registry/trackedThreads.ts` exposes `getTrackedThreads(filter?)` and keeps the current storage backend (`chrome.storage.local`) behind that interface.

Important nuance: `lastTurnAt` is currently the last local observation time from a capture or selector-canary load, not a provider-sourced server timestamp.

## Selector Canary And Clipboard Fallback

- On every capture-ready provider tab load, the content script now runs a selector canary and records the outcome locally.
- The side panel shows per-provider recent health such as `8/10 recent loads clean`, with separate fallback and failed counts.
- If the active tab's latest canary is `fallback` or `stale`, the side panel surfaces an extractor warning and a `Capture + copy fallback` action that copies a conservative local markdown capture to the clipboard.

## What Is Proven Right Now

- Existing-tab capture is mechanically sound for provider-like pages and real logged-in pages.
- The extension can keep all captured artifacts local.
- The side panel is enough to review captures and selector health.
- The TechPulse-style automated harness is working for this POC.
- Real ChatGPT signed-in thread capture is proven on both normal and project thread routes.
- Real Claude signed-in thread capture is proven with a live-DOM regression fixture and heading fallback.
- Real Gemini capture is strong enough to include assistant output plus rich visible document content.
- The future MCP server can read tracked threads through `getTrackedThreads(filter?)` without knowing about `chrome.storage.local`.

## What Is Not Yet Proven

- Long-term DOM stability for any real provider
- Prompt injection or response automation for real providers
- Cloud sync
- Vault `Source` artifact migration for provider captures
- End-to-end local encryption
- Production-grade security review

## Storage Handoff Decision

For this PoC, captures and the tracked-thread registry stay in `chrome.storage.local`.

Why this stays local for now:

- the future MCP server needs a fast, browser-local reader surface first
- `poc/obsidian-integration` is still focused on synthetic thin-slice vault mechanics rather than provider-thread ingestion
- moving capture records into vault `Source` artifacts now would add backfill, dual-write, and artifact-shape decisions before the MCP reader is even wired

The intended v1 path is to keep `getTrackedThreads(filter?)` stable, then change the storage backend behind that interface once vault `Source` artifact ownership is ready.

## Deferred To V1

`window.fetch` / SSE interception remains deferred. The DOM path is now good enough for the PoCs, and fetch interception should be treated as a durability upgrade for v1 rather than a prerequisite for the current provider-capture or MCP-reader slice.

## How To Try The Live POC Manually

1. Build the extension:

```sh
cd poc/provider-capture
npm install
npm run build
```

2. In Chrome, open `chrome://extensions`, enable Developer mode, and load unpacked:

```text
poc/provider-capture/.output/chrome-mv3
```

3. Open a supported tab:

- `chatgpt.com`
- `claude.ai`
- `gemini.google.com`
- or one of the local fixture pages used by the tests

4. Open the extension side panel.

5. Confirm the `Active Tab` section shows the provider, title, and URL.

6. Click `Capture active tab`.

7. Review the capture card and preview:

- provider label
- turn count
- selector canary
- selector health
- warnings
- extracted turns with source labels

8. Reload the page or reopen the side panel and confirm the capture is still present.

## Why This POC Exists

The first POC proved the dogfood loop for note fork, converge, and patch. This second POC isolates the harder plugin-specific primitive underneath that vision:

`Can the extension reliably read visible provider content from tabs the user already has open, while keeping the data local and staying conservative about what it touches?`

For Gemini, the answer is now yes.

For ChatGPT, the answer is yes for shared/canvas capture and still needs one more live proof on a normal loaded conversation thread.

For Claude, the fixture path is proven and the logged-in live pass is still pending.
