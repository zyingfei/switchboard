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

## Release standards

- Use semantic versioning for extension releases.
- Keep manifest permissions reviewed for every release.
- Generate production builds with source maps policy decided explicitly.
- Verify Web Store/privacy disclosures match actual data use.
- Maintain rollback and hotfix process.

## Browser-plugin review checklist

Use `checklists/browser-plugin-design-review.md` for new plugin features.
