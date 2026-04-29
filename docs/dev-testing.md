# Dev testing — Sidetrack extension

How to drive the side panel + capture pipeline against real and synthetic
provider pages, without re-logging-in to ChatGPT / Claude / Gemini on
every run.

## What's already wired

- **Vitest** (`npm test` in `packages/sidetrack-extension/`) — unit tests
  for the side panel and content extractors.
- **Playwright e2e** (`npm run e2e` in `packages/sidetrack-extension/`) —
  loads the built MV3 bundle into a Chromium persistent profile, mounts
  the side panel, and drives the runtime via
  `chrome.runtime.sendMessage`. Spec files live in `tests/e2e/`; helpers
  in `tests/e2e/helpers/`.
- **Provider HTML fixtures** under
  `poc/provider-capture/fixtures/provider-pages/` — sanitized snapshots
  of ChatGPT / Claude / Gemini DOMs we can serve from a local fixture
  server (`tests/e2e/helpers/fixtures.ts`). The provider content scripts
  only run on the real provider hostnames, so fixtures are **best
  combined with `messageTypes.autoCapture`** (see below).

## Quick-start cycle

```bash
cd packages/sidetrack-extension
npm install
npm run build                     # produces .output/chrome-mv3
SIDETRACK_E2E_HEADLESS=1 npm run e2e
```

`npm run e2e` does, in order:

1. `wxt build` — produce the MV3 bundle.
2. `npm --prefix ../sidetrack-companion run build` — produce the
   companion's compiled JS so e2e specs can boot it.
3. `node scripts/verify-extension-build.mjs` — manifest sanity check.
4. `playwright test` — run every spec under `tests/e2e/`.

Set `SIDETRACK_E2E_HEADLESS=0` to watch the runs in a real Chromium
window. Useful when debugging selectors.

## Driving the side panel from a spec

### 1. Launch the runtime

```ts
import { launchExtensionRuntime } from './helpers/runtime';
const runtime = await launchExtensionRuntime();
```

Returns `{ context, extensionId, sendRuntimeMessage, seedStorage,
close }`. The `context` is a `BrowserContext` with the extension
already loaded; the `extensionId` lets you hit
`chrome-extension://<id>/sidepanel.html`.

### 2. Skip the first-run wizard

The wizard hides the workboard until the user finishes setup. In a test
that doesn't care about wizard ergonomics, seed `setupCompleted` and
let the workboard mount directly:

```ts
const seederPage = await runtime.context.newPage();
await seederPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
  waitUntil: 'domcontentloaded',
});
await runtime.seedStorage(seederPage, {
  'sidetrack:setupCompleted': true,
  'sidetrack.threads': [/* ... */],
  'sidetrack.queueItems': [/* ... */],
});
await seederPage.reload({ waitUntil: 'domcontentloaded' });
```

Storage keys are defined in `src/background/state.ts`.

### 3. Trigger a capture

Two ways, depending on whether you're testing the **content-script
extraction** or just the **post-capture pipeline** (queue auto-detect,
fork lineage resolution, lifecycle pill updates, etc.).

**a. Content-script extraction (real DOM).** The content script is
registered for chatgpt.com / claude.ai / gemini.google.com only, so a
fixture served from localhost won't trigger it. Use this path when
running against the real providers (with a logged-in persistent
profile):

```ts
await providerPage.goto('https://chatgpt.com/c/abc-123');
await providerPage.bringToFront();
await runtime.sendRuntimeMessage(seederPage, {
  type: messageTypes.captureCurrentTab,
});
```

**b. Inject a synthetic capture event.** Use this when driving fixtures
or when you want deterministic turn data:

```ts
await runtime.sendRuntimeMessage(seederPage, {
  type: messageTypes.autoCapture,
  capture: {
    provider: 'chatgpt',
    threadUrl: '...',
    title: '...',
    capturedAt: new Date().toISOString(),
    turns: [
      { role: 'user', text: '...', ordinal: 0, capturedAt: '...' },
      { role: 'assistant', text: '...', ordinal: 1, capturedAt: '...' },
    ],
  },
});
```

The whole post-capture pipeline runs identically — `markQueueItemsDoneFromTurns`,
`resolveParentFromForkSource`, lifecycle-state derivation, reminder
creation. So this is the right path for ~all unit-of-behaviour tests.

`tests/e2e/queue-lifecycle.spec.ts` is the reference example for this
pattern.

## Working with real providers (logged-in profile)

When you need to drive real ChatGPT / Claude / Gemini pages — for
example to capture a fresh DOM dump or to verify the fork-source
detector against a live "Branched from" indicator — use a long-lived
persistent profile so you only log in once:

```bash
mkdir -p ~/.sidetrack-test-profile
SIDETRACK_E2E_HEADLESS=0 \
  SIDETRACK_USER_DATA_DIR=~/.sidetrack-test-profile \
  npx playwright test tests/e2e/<your-spec>.spec.ts
```

> The `runtime` helper currently always creates a fresh tmpdir profile;
> if you want the env-var to take effect, edit
> `tests/e2e/helpers/runtime.ts` `launchExtensionRuntime` to honour
> `SIDETRACK_USER_DATA_DIR` before calling `mkdtemp`. Small follow-up;
> not blocking real-provider runs today (you can manually point a spec
> at a fixed dir).

In the persistent profile, log into each provider once. Cookies + local
storage survive across runs.

## Capturing a new fixture

When a provider's DOM shifts and you want to add or refresh a fixture:

1. In the dev side panel, open the page and click **Track current tab**.
2. Inspect the resulting capture event in the companion's vault under
   `_BAC/events/<date>.jsonl` — the captured turns + selector canary
   tell you whether the existing extractor still works.
3. If the extractor needs updating, copy the page source (right-click →
   View source → Save as) into
   `poc/provider-capture/fixtures/provider-pages/<provider>-<scenario>.html`,
   strip personally-identifying content, and add a spec under
   `tests/e2e/` that loads it via the fixture server.

Sanitization rules:

- Replace user emails / names with `user@example.com` / "Test User".
- Strip auth headers, cookies, IP-bound URLs.
- Keep enough turn structure for the extractor to exercise both `user`
  and `assistant` selectors.

## Tasks the user wants automated

The current scope of automated coverage:

- ✅ Side panel mounts, workboard renders.
- ✅ Queue auto-detect: a pending follow-up flips to `done` when its
  text appears as a user turn in a subsequent capture.
- 🔧 Provider extractors against the existing fixture set — covered by
  the older `extension-runtime.spec.ts` which is currently skipped
  pending a port to the post-rewrite UI (see TODO in that file).
- ⏳ Fork lineage detection against a real Claude "Branched from"
  thread — needs a captured Claude fixture.
- ⏳ Dispatch flow end-to-end including PacketComposer template
  rendering, last-N-turns slider, token-preview math.

Pull from this list when picking the next spec to write.
