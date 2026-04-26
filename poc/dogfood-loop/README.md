# Dogfood Loop POC

This is the first Browser AI Companion POC. It lives at `poc/dogfood-loop/` and proves the core local-first loop:

```text
markdown note -> fork targets -> inject/dispatch -> observe completion -> store artifacts -> converge -> patch note
```

The project is intentionally narrow. It reuses the TechPulse browser companion shape where useful: WXT, React, TypeScript, Chrome MV3 side panel, a background coordinator, tab-based targets, local persistence, Vitest unit coverage, and Playwright extension e2e coverage.

## What It Proves

- A local markdown note can be saved in the extension side panel.
- The note can be forked to two mock chat targets.
- Mock chat pages receive generated prompts and auto-send deterministic fake assistant responses.
- The background worker tracks prompt runs, graph nodes, graph edges, and event-log entries.
- Completed branch artifacts are stored locally in IndexedDB.
- The side panel shows a converge view with responses side by side.
- The user can choose `Use A`, `Use B`, or `Append both`.
- A deterministic markdown patch is generated against the source note.
- Accepting the patch persists the updated note locally.
- Google Search and DuckDuckGo can be used as navigation-only workstream targets.
- An existing active tab can be added into the discussion as a local source artifact.
- Fixture ChatGPT, Claude, and Gemini tabs can be detected in a thread registry.
- The local graph can be projected into Obsidian-shaped files.
- A portable Context Pack can be generated from the current workstream.
- A read-only MCP-core smoke path can answer recent-thread, workstream, and context-pack requests.
- A lexical "déjà-vu" recall spike can find related local artifacts.

## What It Does Not Prove

- Real ChatGPT, Claude, Gemini, or other provider DOM stability.
- Provider login flows or anti-automation behavior.
- Search result extraction, ranking, or result-page DOM stability.
- Obsidian Local REST API integration.
- Real MCP server transport, native helper packaging, or process lifetime management.
- Vector recall with PGlite, pgvector, or transformers.js.
- Cloud sync.
- Production-grade security review.

The second POC for provider content capture is separate at `poc/provider-capture/`.

## MCP Contract

`src/mcp/contract.ts` is the canonical source for the POC MCP surface. It defines the tool names, input schemas, request types, and response types for `bac.recent_threads`, `bac.workstream`, `bac.context_pack`, and lexical `bac.search`; `src/mcp/server.ts` imports that contract so the smoke implementation and documented tool surface stay in lockstep. Downstream POCs still own the keep, retire, or refactor decisions for `src/vault/`, the in-process `src/mcp/server.ts` smoke, and the lexical `src/recall/` spike.

## Install And Verify

Run from this folder:

```sh
cd poc/dogfood-loop
npm install
npm run compile
npm test
npm run build
```

Install Chrome for Testing once before running e2e:

```sh
npm run e2e:install
npm run test:e2e
```

Useful e2e environment variables:

```sh
BAC_E2E_CHROME_PATH=/path/to/chrome npm run test:e2e
BAC_E2E_HEADLESS=1 npm run test:e2e
BAC_EXTENSION_PATH=/path/to/chrome-mv3 npm run test:e2e
```

The e2e runner follows the TechPulse-style extension harness: build the WXT extension, launch Chrome with the unpacked MV3 output, open `chrome-extension://<extension-id>/sidepanel.html`, and exercise the workflow in browser tabs.

## Try It Manually

Build the extension:

```sh
cd poc/dogfood-loop
npm install
npm run build
```

Load `.output/chrome-mv3` in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select `poc/dogfood-loop/.output/chrome-mv3`.
5. Open the extension side panel. If the side panel is awkward to reach, copy the extension ID from `chrome://extensions` and open `chrome-extension://<extension-id>/sidepanel.html` directly.

Then exercise the core loop:

1. In `Current note`, enter:

   ```md
   # Brainstorm
   Please review this product idea.
   ```

2. Click `Save`.
3. Click `Fork to both chats`.
4. Confirm two mock chat tabs open, one for Mock Chat A and one for Mock Chat B.
5. Confirm each mock tab receives the note prompt and reaches `done`.
6. Return to the side panel and wait for both run rows to show `Done`.
7. In `Converge view`, click `Append both`.
8. Check that `Patch preview` includes both responses.
9. Click `Accept patch`.
10. Reload the side panel and confirm the updated note is still present.

Optional manual spikes:

- Click `Fork to search engines` to open Google and DuckDuckGo query tabs and store navigation-only artifacts.
- Open any normal browser tab, return to the side panel, and click `Add active tab to discussion`.
- Click `Open fixture threads`, then `Refresh registry`, to prove fixture ChatGPT, Claude, and Gemini thread detection.
- Click `Build vault projection` to see Obsidian-shaped output paths.
- Click `Build Context Pack` to preview a portable markdown handoff.
- Click `MCP smoke` to run the read-only MCP-core request path in-process.
- Enter a phrase in `Recall probe` and click `Check déjà-vu`.

## Test Coverage

Unit tests live in `tests/unit/` and cover:

- graph store append/read behavior
- graph node and edge creation
- fork operation creation of note nodes, prompt runs, and fork edges
- mock chat adapter injection and completion detection
- convergence node creation
- deterministic markdown patch generation
- preflight warnings for obvious secrets, emails, and private URLs
- search adapter query and artifact behavior
- registry, vault projection, Context Pack, MCP smoke, and recall helpers

Browser tests live in `tests/e2e/mock-dogfood-loop.spec.ts` and cover:

- note -> mock chats -> observed responses -> converge -> patch -> persisted note
- note -> Google/DuckDuckGo navigation targets -> local search artifacts
- active-tab adoption, fixture thread registry, vault projection, Context Pack, recall, and MCP smoke

## Privacy Posture

- No paid API calls.
- No backend.
- No full DOM capture.
- No screenshots.
- No cookies or localStorage reads.
- No hidden input scraping.
- Mock chat targets are extension-owned fixture pages.
- Search forks only open explicit query URLs and do not read result-page DOM.
- Dispatch preflight warns on long prompts, possible API keys, emails, and private/internal URLs.
- All core workflow state is local to the extension.

## Project Map

```text
entrypoints/
  background.ts              MV3 background service worker entry
  sidepanel.html             side panel HTML entry
  sidepanel/                 React side panel UI
  mock-chat/                 extension-owned mock chat target page
  thread-fixture/            fixture provider-thread page
src/
  adapters/                  mock chat and search target adapters
  background/                workflow coordinator, routing, tab location
  context/                   Context Pack generation
  graph/                     typed model, IndexedDB store, memory store, operations
  mcp/                       in-process read-only MCP JSON-RPC core
  patch/                     deterministic markdown patch builder
  preflight/                 dispatch warnings
  recall/                    lexical déjà-vu spike
  registry/                  thread registry classification
  vault/                     Obsidian-shaped projection
tests/
  unit/                      Vitest unit coverage
  e2e/                       Playwright extension coverage
```

## Acceptance Commands

Use these as the quick "is this POC still healthy?" check:

```sh
cd poc/dogfood-loop
npm run compile
npm test
npm run build
npm run test:e2e
```
