# TypeScript Browser Plugin Design Review Checklist

Use this before adding or changing extension features.

## Manifest and permissions

- [ ] Manifest changes are reviewed.
- [ ] Permissions are least-privilege.
- [ ] `activeTab` or optional permissions are used where practical.
- [ ] `<all_urls>` is avoided or security-approved.
- [ ] Permission-denied flow is implemented and tested.
- [ ] Web-accessible resources are minimal and justified.

## Architecture

- [ ] Content script only handles DOM/page interaction and messaging.
- [ ] Service worker does not rely on persistent in-memory state.
- [ ] UI does not directly call privileged browser APIs unless justified.
- [ ] Application/domain code is testable outside browser runtime.

## Messaging

- [ ] Message schema exists.
- [ ] Inbound messages are validated.
- [ ] Message versioning is handled.
- [ ] Request ID/correlation ID included.
- [ ] Timeout behavior exists for request/response flows.
- [ ] New message handler is registered through router/registry.

## Storage

- [ ] Storage records are versioned.
- [ ] Reads validate data before use.
- [ ] Migration path exists for changed records.
- [ ] Sensitive data is not stored in sync storage.
- [ ] Content-script storage access is restricted if needed.

## Security

- [ ] No dynamic remote code or eval-like behavior.
- [ ] Page-bridge origin/source checks are implemented.
- [ ] HTML rendering is sanitized.
- [ ] Logs redact URL query strings, tokens, cookies, and page content.
- [ ] Dependency/security scan passes.

## Operations

- [ ] User action telemetry is defined.
- [ ] Errors have categories and user-safe messages.
- [ ] Performance impact on page DOM is reviewed.
- [ ] Service-worker lifecycle behavior is tested.

## Tests

- [ ] Typecheck passes.
- [ ] Lint passes.
- [ ] Message router/schema tests exist.
- [ ] Storage migration tests exist.
- [ ] Content-script fixture tests exist where DOM is used.
- [ ] E2E smoke test covers critical flow where feasible.
