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

For specs that drive real chatgpt.com / claude.ai / gemini.google.com
pages — verifying live DOM extraction, fork-source detection against a
real "Branched from" indicator, or the dispatch flow against a live
chat — use a long-lived Chromium profile so you only log in once.

### One-time setup

```bash
cd packages/sidetrack-extension
npm run e2e:login
```

That builds the extension, opens a **headed Chrome stable window**
(not Playwright's Chromium — see below) with the extension loaded and
the persistent profile attached (`~/.sidetrack-test-profile` by
default), and pre-opens tabs for chatgpt.com / claude.ai /
gemini.google.com. Log in to each one. Close the window when done —
your cookies stay in the profile dir.

> **Why Chrome stable, not Chromium?** Google's OAuth flow refuses
> Playwright's Chromium build with *"This browser or app may not be
> secure"*. Real Chrome is accepted. The login script defaults to
> `channel: 'chrome'`. If you don't have Chrome installed,
> `SIDETRACK_E2E_BROWSER=chromium npm run e2e:login` falls back —
> but Gemini login won't work and ChatGPT-via-Google-SSO won't
> either. ChatGPT email/password and Claude email/password still
> work in Chromium.

Override the profile path:

```bash
SIDETRACK_USER_DATA_DIR=~/.my-test-profile npm run e2e:login
```

### Running a spec against the logged-in profile (CDP-attach flow)

**Important: this uses Chrome for Testing (CfT), not regular Chrome
stable.** Regular Chrome stable on macOS silently rejects unpacked
extensions when launched outside Playwright, and Playwright's launch
flags (`--use-mock-keychain`, `--remote-debugging-pipe`) collide with
external CDP attach. CfT is Google's automation distribution and
doesn't have either restriction.

**One-time install:**

```bash
cd packages/sidetrack-extension
npm run e2e:install-cft
```

That downloads CfT into `./.chrome-for-testing/` (~200MB; gitignored).

**Terminal A — keep CfT running with the extension + your cookies:**

```bash
cd packages/sidetrack-extension
npm run e2e:chrome-debug
```

This launches CfT with the extension loaded, the dedicated profile
attached (`~/.sidetrack-test-profile-cft`), and
`--remote-debugging-port=9222` open. It also pre-opens chatgpt.com /
claude.ai / gemini.google.com tabs. **First run, sign in to each
provider.** Cookies persist across runs. Leave the window open;
navigate to whichever chats you want specs to capture against.

**Terminal B — run any spec, attaching over CDP:**

```bash
SIDETRACK_E2E_CDP_URL=http://localhost:9222 \
  npx playwright test tests/e2e/live-providers-smoke.spec.ts
```

Specs detect `SIDETRACK_E2E_CDP_URL` and skip launching a new browser
— they attach to the running Chrome via `chromium.connectOverCDP`,
reuse its existing context, and find the extension's service worker
that Chrome already registered.

Why CDP-attach and not `launchPersistentContext` against a Chrome
stable profile? Two reasons:

1. **Cookies.** Chrome stable encrypts cookies with the macOS keychain
   key. If Playwright launches the same profile under Chromium, the
   cookies can't be decrypted — Claude shows the login page,
   ChatGPT goes to the public landing, Gemini hits Cloudflare.
2. **MV3 service workers.** Playwright + Chrome stable +
   `--load-extension` is unreliable about exposing the extension's
   service worker; Playwright + Chromium works but suffers (1).
   CDP-attach hands the lifecycle to Chrome, which works.

### Older tmpdir flow (still supported, no login required)

```bash
npx playwright test tests/e2e/queue-lifecycle.spec.ts
```

When neither `SIDETRACK_E2E_CDP_URL` nor `SIDETRACK_USER_DATA_DIR` is
set, every run gets a fresh tmpdir profile under Playwright Chromium,
wiped on close. This is what the synthetic specs (queue-lifecycle,
fork-lineage, archive-restore, extension-runtime) use.

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
