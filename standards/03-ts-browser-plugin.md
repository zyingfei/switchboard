# TypeScript Browser Plugin Coding Standards

## Objective

The browser plugin must be secure, least-privilege, type-safe, lifecycle-safe under Manifest V3 service workers, and extensible through typed message/capability registries.

## Browser-extension architecture

Recommended structure:

```text
browser-plugin/
  src/
    background/          # Manifest V3 service worker/event orchestration
    content/             # content scripts; DOM extraction and page interaction only
    ui/                  # popup/options/sidebar pages
    page-bridge/         # optional injected page-world bridge when needed
    messaging/           # typed message schemas, bus, handlers
    storage/             # typed storage repositories and migrations
    permissions/         # permission request/check helpers
    application/         # use cases independent of Chrome APIs
    domain/              # pure models/invariants
    infrastructure/      # Chrome/WebExtension adapters, API clients
    telemetry/           # logs/metrics/error reporting wrappers
```

Rules:

- Content scripts handle DOM interaction and message passing; they do not own business logic.
- The service worker orchestrates events; it does not hold critical state only in memory.
- UI pages render and dispatch commands; they do not call browser APIs directly except through adapters.
- Application/domain code must be testable without a real browser.

## TypeScript standard

Use strict TypeScript.

Required compiler options are provided in `configs/ts/tsconfig.base.json`.

Rules:

- `any` is prohibited except in generated code or very small quarantine wrappers.
- Use `unknown` at boundaries and parse with schemas.
- Prefer discriminated unions for messages and events.
- Use exhaustive checks for message variants.
- Prefer `readonly` data structures for DTOs.
- Avoid ambient globals except typed browser API declarations.
- Do not suppress TypeScript errors without a comment explaining risk and owner.

## Manifest V3 standards

- Use Manifest V3.
- Use a service worker for background orchestration.
- Do not assume service-worker memory persists between events.
- Initialize dependencies lazily and idempotently.
- Persist state that must survive worker termination.
- Use alarms, storage, or queues for delayed work instead of `setInterval` loops.

## Permissions standard

The extension must request the smallest practical permission set.

Rules:

- Prefer `activeTab` for user-invoked page access.
- Prefer `optional_permissions` and `optional_host_permissions` for features not always needed.
- Avoid `<all_urls>` unless a security review approves it.
- Use `declarativeNetRequest` instead of broad webRequest interception where possible.
- Document every permission in `permissions/README.md` or the feature spec.
- Add tests or review notes for permission-denied flows.

## Content-script standards

- Treat DOM data as untrusted.
- Keep selectors centralized and tested where practical.
- Avoid long-running synchronous DOM work.
- Use MutationObserver carefully with throttling/debouncing and disconnect paths.
- Do not inject page-world scripts unless isolated-world content scripts cannot do the job.
- Do not expose extension internals through web-accessible resources unless required.
- Never trust messages from the page without origin/source validation.

## Messaging standards

All cross-context messages must use typed schemas.

Message envelope:

```ts
export type ExtensionMessage<TType extends string, TPayload> = Readonly<{
  type: TType;
  version: 1;
  requestId: string;
  source: 'popup' | 'options' | 'background' | 'content' | 'page-bridge';
  target: 'popup' | 'options' | 'background' | 'content' | 'page-bridge';
  payload: TPayload;
}>;
```

Rules:

- Validate every inbound message.
- Reject unknown versions.
- Attach request IDs for request/response flows.
- Add timeouts for calls that expect responses.
- Avoid broadcast messages unless necessary.
- Keep message handlers registered through a typed registry.
- Never pass raw DOM nodes, functions, or non-serializable objects through extension messaging.

## Open/closed messaging implementation

Use a registry instead of central `switch` blocks.

Conceptual shape:

```ts
export interface MessageHandler<TMessage, TResult> {
  readonly type: string;
  handle(message: TMessage, ctx: MessageContext): Promise<TResult>;
}

export class MessageRouter {
  private readonly handlers = new Map<string, MessageHandler<unknown, unknown>>();

  register(handler: MessageHandler<unknown, unknown>): void {
    if (this.handlers.has(handler.type)) throw new Error(`Duplicate message handler: ${handler.type}`);
    this.handlers.set(handler.type, handler);
  }

  async dispatch(message: { type: string }, ctx: MessageContext): Promise<unknown> {
    const handler = this.handlers.get(message.type);
    if (!handler) throw new Error(`Unsupported message type: ${message.type}`);
    return handler.handle(message, ctx);
  }
}
```

A new feature registers a new handler and schema; it does not modify the router.

## Storage standards

- Use extension storage APIs through typed repositories.
- Validate data read from storage; storage can contain old versions or corrupted data.
- Version storage records and provide migrations.
- Do not store access tokens in sync storage.
- Do not expose sensitive storage to content scripts unless explicitly required.
- Keep storage reads/writes async and batched where possible.

## API/network standards

- Use a single API client adapter with retries, timeouts, auth handling, and error mapping.
- Do not call `fetch` directly from UI/content/application code.
- Redact sensitive headers and payloads in logs.
- Respect CORS and host permission requirements.
- Back off on retries and avoid retrying non-idempotent requests without idempotency support.

## Security standards

- No `eval`, dynamic remote code, or inline script shortcuts.
- Keep Content Security Policy strict.
- Validate origins for page-bridge communication.
- Sanitize any HTML rendered from external or page data.
- Do not expose privileged extension capabilities to page scripts.
- Use feature-specific permission prompts and explain why access is needed.
- Keep dependencies minimal and audited.

## UI standards

- UI state should be derived from typed application state.
- Avoid direct browser API calls from UI components; use application services or adapters.
- Handle loading, error, permission-denied, and empty states.
- Avoid layout shifts and long blocking work in popup/options pages.
- Keep accessibility basics: labels, keyboard navigation, focus handling, contrast.

## Observability standards

Every user-invoked action should emit:

- Action name.
- Request ID/correlation ID.
- Extension version.
- Browser context: popup/content/background/options, without leaking page data.
- Permission state where relevant.
- Outcome, latency, error category.

Do not log raw page content, full URLs with sensitive query strings, tokens, cookies, or user-entered secrets.

## Testing standards

Required tests:

- Unit tests for application/domain logic.
- Message schema and router tests.
- Storage migration tests.
- Permission-denied tests.
- Content-script DOM extraction tests with representative fixtures.
- Service-worker lifecycle tests for idempotent initialization.
- E2E smoke tests with Playwright or equivalent extension-capable test runner for critical flows.

## Debugging-pit best practices

Lessons that took weeks to learn debugging the engagement subsystem
(Stage 5.0). Each one is paired with the symptom it produces so the
next operator can recognize it faster.

### 1. Plan-comments are not route implementations

> Symptom: a critical event stream silently returns 0 in materializer
> counters for weeks; everything looks correctly wired upstream.

The plugin POSTed engagement events to `/v1/edge/events` for 3 weeks.
The companion responded with 404 the whole time because the route had
only been *planned* — there was a comment on `/v1/timeline/events`
saying "a future generic `/v1/edge/events` router would be a separate
route" and the future never arrived. The buffer drain swallowed the
404 silently because it treats any non-2xx as transient.

Rule: when a comment references a route or function as future work,
either implement it the same commit or open a tracked issue. Never
ship code that depends on a comment-only future commitment.

### 2. `chrome.runtime.sendMessage` from SW DevTools is a no-op

> Symptom: `await chrome.runtime.sendMessage({type: 'sidetrack.dev.ping'})`
> in the service-worker DevTools console returns `undefined` even
> though the listener is wired and the handler is reachable from
> other contexts.

Chrome routes `runtime.sendMessage` to all extension contexts EXCEPT
the sender. The SW DevTools console IS the SW context. So a ping
sent from there never reaches the SW's onMessage listener.

Rule: never debug a SW message handler from the SW DevTools console.
Open a side-panel or popup DevTools instead. For SW-only state, expose
a `globalThis.__sidetrackDebug` hook the operator can read directly
without going through the message bus.

### 3. `chrome.storage.local.set` from inside the SW listener body is unreliable on Chrome 148+

> Symptom: diagnostic journal stays empty even though the SW handler
> definitely runs (we see its return value reach the caller).

We hit this twice — once on a `lastMessage` stash, once on the
engagement-sync journal. Writes from inside SW `onMessage` listener
bodies intermittently fail to persist on Chrome 148. The same code
works fine from a popup or side-panel page.

Rule: diagnostic journals from the SW use a module-level array
mirrored to `chrome.storage.session` AND `console.warn`. Read primary
from `globalThis` via SW DevTools; read secondary from session storage
via any page DevTools; tertiary from the console output stream.

### 4. Per-row `useEffect` fetches do not scale

> Symptom: console floods with `ERR_INSUFFICIENT_RESOURCES` failures;
> Inbox stays empty for minutes; companion health probe flashes red
> intermittently.

A list of N suggestion rows where each row's `useEffect` fires a
`/v1/suggestions/thread/{id}` fetch produces N parallel HTTP requests
on first paint. Chrome's per-origin socket cap (~6 for HTTP/1.1) is
exhausted; the companion's single-threaded HTTP loop chokes; the
periodic health probe starves and the UI shows the companion as down.

Rule: ALL fetches to the companion go through a module-level
semaphore (`acquireCompanionFetchSlot`) capped at 4 in-flight. The
semaphore must use slot-transfer on release (pop queue, call next
WITHOUT decrement). The naive
`active--; queue.shift()?.resolve()` has a microtask gap where a new
acquire can slip in past MAX, and under load `active` drifts upward
permanently — every waiter gets stuck.

### 5. Manifest version must encode build time

> Symptom: operator can't tell from chrome://extensions which bundle
> is loaded; turnaround after every rebuild involves a guess about
> whether the change took effect.

The pkg.json version stays at `0.0.0` forever. Encode build identity
into the chrome manifest version: `0.<YY>.<MMDD>.<HHMM>` (each
segment 0-65535, the Chrome limit). Now `chrome://extensions` shows
`0.26.511.2225` directly — instant freshness check.

Append `-dirty` to the in-bundle sha when `git status --porcelain` is
non-empty so the footer banner distinguishes built-from-WIP from
built-from-clean-sha.

### 6. The recorder must be CDP-attachable on demand

> Symptom: a frustrating debug arc where every diagnostic requires
> the operator to paste output from DevTools.

Patchright stealth deliberately hides CDP (anti-detection wins it),
but the same property prevents an agent or operator from attaching
Playwright to inspect SW state directly. Gate a `--remote-debugging-port`
flag behind `SIDETRACK_E2E_CDP_DEBUG_PORT=<port>` so operators can
attach via `chromium.connectOverCDP("http://localhost:<port>")` when
debugging — and turn it off for real recording sessions.

### 7. Fold journals into existing diagnostic dumps

> Symptom: a journal exists but nobody finds it because reading it
> requires opening DevTools, knowing the storage key, and pasting the
> result somewhere the agent can read.

The recorder already writes a periodic SW-diag dump to
`<run>/sw-diag/<ts>-{A,B}.json` every 20 s. Fold any new diagnostic
journal into the `sidetrack.dev.diag` response shape so it lands in
those artifact files automatically. Then an agent can read the files
directly from disk — no operator turnaround.

### 8. `chrome.scripting.registerContentScripts` only injects on FUTURE navigations

> Symptom: engagement script is registered but emits zero events on
> already-open tabs; engagement counters stay at zero until the user
> manually refreshes every tab.

Runtime registration is forward-looking. For tabs that were open
BEFORE registration, you must `chrome.scripting.executeScript` against
each one explicitly. Build this into the same code path as the
registration call, not as a separate `reinjectContentScriptIntoOpenTabs`
helper that gets forgotten.

### 9. Privacy gates are state, not consent

> Symptom: a privacy gate stays closed for production users forever
> because no UI path opens it; only test scripts wrote
> `privacy.gate.flipped` events.

If a subsystem is "default-on after user opt-in to the umbrella
feature," its privacy gate must auto-open the first time the
umbrella feature is enabled. Test scripts opening a gate proves the
mechanism works, not that users will actually flip it. Either flip
it automatically (preferred) or expose a UI toggle (acceptable) — but
never let a gate exist only in test code.

## Release standards

- Use semantic versioning for extension releases.
- Keep manifest permissions reviewed for every release.
- Generate production builds with source maps policy decided explicitly.
- Verify Web Store/privacy disclosures match actual data use.
- Maintain rollback and hotfix process.

## Browser-plugin review checklist

Use `checklists/browser-plugin-design-review.md` for new plugin features.
