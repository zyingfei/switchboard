# Engineering Baseline

## Purpose

This baseline applies across languages. Component-specific standards extend it.

## Design principles

- **Single responsibility:** modules should have one reason to change.
- **Dependency inversion:** application services depend on ports, not concrete SDKs or frameworks.
- **Open/closed:** new variants are added through registries, strategies, event handlers, route modules, and capability modules.
- **Explicit boundaries:** do not pass raw framework request objects, MCP payloads, browser messages, DOM nodes, or third-party JSON into domain code.
- **Immutability by default:** prefer immutable values and pure functions for domain logic.
- **Composition over inheritance:** use interfaces, factories, and dependency injection for variability.
- **Fail closed:** when authz, validation, capability negotiation, or permission checks are ambiguous, deny.

## Boundary validation

Validate these inputs before use:

- HTTP request bodies, query params, path params, headers, cookies.
- MCP tool arguments, resource URIs, prompt arguments, transport metadata.
- Browser-extension messages, content-script DOM extraction, storage records, tab metadata, URL match results.
- Third-party API responses and webhook payloads.
- Environment variables and config files.

Recommended pattern:

```text
raw input -> schema parse -> typed DTO -> application command/query -> domain model
```

Do not let raw JSON cross into application or domain layers.

## Error handling

Use typed errors and convert them at the boundary.

Minimum categories:

- Validation error.
- Authentication error.
- Authorization/permission error.
- Not found.
- Conflict/version mismatch.
- Rate limit/quota error.
- Timeout/cancellation.
- Dependency failure.
- Internal invariant failure.

Rules:

- Never leak secrets, tokens, stack traces, or raw third-party payloads in external errors.
- Include a correlation/request ID in every external error response where possible.
- Keep domain errors separate from protocol/framework errors.
- Use exhaustive mapping from internal error category to protocol error shape.

## Observability

Every externally meaningful operation should emit:

- A trace/span with stable operation name.
- Structured logs with correlation ID, operation, actor/tenant if available, resource identifiers, outcome, latency, and error category.
- Metrics for latency, throughput, error count, retry count, timeout count, and dependency failures.

Avoid logging:

- Access tokens, refresh tokens, cookies, authorization headers.
- Full browser page content.
- Raw personal data unless explicitly approved and redacted.
- Full request/response bodies by default.

## Config and secrets

- Read config once at process startup or extension initialization through a typed config loader.
- Validate required config with schemas.
- Inject config into services; do not read `process.env` or extension storage directly inside domain/application code.
- Never hardcode secrets.
- Keep local-dev defaults safe and clearly marked.

## Testing pyramid

Minimum test layers:

- Unit tests for domain logic and pure utilities.
- Application-service tests with fake ports.
- Contract tests for HTTP/MCP/browser-message boundaries.
- Integration tests for persistence, external SDK adapters, and browser APIs where practical.
- E2E smoke tests for one or two critical user journeys.

For POC migration, first create behavior tests that prove which POC behavior is intentionally retained.

## Language-specific expectations

### TypeScript

- Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `useUnknownInCatchVariables`.
- Use `unknown`, not `any`, at untrusted boundaries.
- Parse boundary data with a schema library such as Zod, Valibot, ArkType, TypeBox, or generated validators.
- Use discriminated unions for protocol/message variants.
- Use exhaustive checks for variants.
- Prefer `readonly` and immutable DTOs.
- Avoid default exports for shared modules unless framework conventions require them.
- Use type-only imports where appropriate.
- Keep generated API/types in a dedicated generated folder and wrap them with validation and domain adapters.

### Python

- Use Python 3.12+ unless deployment constraints require otherwise.
- Enable strict type checking with mypy or pyright.
- Use Ruff for linting/formatting.
- Require typed function signatures in production code.
- Use Pydantic/dataclasses/attrs for boundary DTOs.
- Keep business exceptions typed and mapped at the boundary.
- Prefer dependency injection over importing concrete clients inside services.

### Go

- Pass `context.Context` through request-scoped calls.
- Use small packages by domain concept, not by technical layer alone.
- Return explicit errors and wrap with context.
- Avoid global mutable state.
- Use interfaces only at consumer boundaries, not everywhere.
- Run `go vet`, `staticcheck`, and race tests for concurrent code.

### Java/Kotlin

- Use constructor injection.
- Keep domain models free of framework annotations when feasible.
- Prefer immutable values and explicit nullability.
- Keep transaction boundaries in application services.
- Use Bean Validation or schema validation at DTO boundaries, not as the only domain invariant enforcement.

## Dependency standards

- Every new dependency must have a reason: security, maintainability, performance, or correctness.
- Prefer mature libraries with active maintenance, clear licensing, typed APIs, and minimal transitive risk.
- Pin versions and maintain a dependency update process.
- Wrap SDKs behind ports when they touch application logic.

## CI baseline

Every package should expose commands equivalent to:

```bash
lint
format:check
typecheck
test
build
security:scan
```

The `scripts/verify-standards.sh` file provides a starter aggregator.
