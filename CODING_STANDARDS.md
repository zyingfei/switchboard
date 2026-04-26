# Coding Standards

## Scope

These standards apply to all production code in the API component, MCP components, and TypeScript browser plugin. They intentionally separate POC behavior discovery from production implementation quality.

## Non-negotiables

1. **Contract first at boundaries.** HTTP endpoints, MCP capabilities, browser-extension messages, storage records, and emitted events must have explicit schemas.
2. **Thin delivery layer.** Controllers, MCP handlers, service-worker listeners, and content-script listeners must delegate to application/domain services.
3. **No unvalidated boundary input.** Treat HTTP bodies, MCP tool inputs, browser messages, storage data, DOM data, and third-party API responses as `unknown` until parsed and validated.
4. **Open for extension, closed for modification.** Add new features through route modules, handlers, strategy implementations, capability modules, message handlers, and typed registries instead of modifying central `switch`/`if` blocks.
5. **No hidden global state.** Runtime state must be injected, scoped, persisted where required, and observable.
6. **Observability is part of the feature.** Every externally meaningful operation must be traceable with request/correlation IDs, structured logs, metrics, and error classification.
7. **Security is designed, not bolted on.** Enforce least privilege, authentication, authorization, input limits, rate limits, secret handling, and audit trails at the component boundary and the application-service boundary.
8. **Tests define POC learning.** Before rewriting POC code, capture the behavior that matters as unit, integration, contract, or acceptance tests.

## Code quality gates

A change is production-ready only if all relevant gates pass:

- Type checking or static analysis.
- Linting with agreed rules.
- Formatter check.
- Unit tests.
- Integration/contract tests for external boundaries.
- Security review for permission, auth, storage, and data-flow changes.
- Performance review for hot paths, polling, streaming, browser DOM work, or MCP tools that call external systems.
- Documentation update for new API endpoints, MCP capabilities, or browser-extension message contracts.

## Preferred architecture

Use ports-and-adapters / hexagonal architecture for all three components.

```text
interface/adapters
  HTTP controllers, MCP protocol handlers, browser message listeners, extension UI adapters
application
  use cases, commands, queries, transaction orchestration, policy checks
core/domain
  domain models, invariants, pure services, business errors
infrastructure
  persistence, network clients, browser APIs, filesystem, auth providers, telemetry sinks
shared-kernel
  typed primitives, result/error helpers, schema utilities, observability helpers
```

Rules:

- Interface code may depend on application services.
- Application code may depend on domain abstractions and ports.
- Domain code must not depend on HTTP, MCP SDKs, browser APIs, databases, cloud SDKs, or process environment.
- Infrastructure implements ports and is wired through composition roots.
- Tests may use fake adapters; production code must not import test fakes.

## Extension-point standards

Use explicit extension points when behavior varies by provider, resource type, tool, permission profile, or browser context.

Acceptable extension patterns:

- Handler registry keyed by stable operation names.
- Strategy interface with injected implementations.
- Middleware/interceptor pipeline for cross-cutting behavior.
- Command/query handler map.
- Plugin/capability module registration.
- Event-subscriber registration.

Avoid:

- Central switch statements that change with every new feature.
- Domain logic in route handlers, MCP tool callbacks, or content scripts.
- Service locators and runtime string imports.
- Copy-pasted provider-specific branches.
- Inheritance for reuse when composition would work.

## POC-to-product conversion rule

POC code can be referenced, but not blindly promoted.

For each POC feature moving into product:

1. Identify useful behavior, edge cases, and integration assumptions.
2. Write acceptance/contract tests from the POC behavior.
3. Design the production boundary contract.
4. Implement through the standard architecture.
5. Delete or archive POC code once tests pass.

## Documentation required per feature

- Boundary contract: OpenAPI path/operation, MCP capability spec, or extension message contract.
- Security impact: data touched, permissions required, auth/authz model, user-consent requirement.
- Failure behavior: retry, timeout, cancellation, fallback, error shape.
- Observability: span names, log fields, metric names.
- Extension model: where a future variant plugs in without modifying core code.

## Review standard

Reviewers should reject product PRs that:

- Add boundary behavior without schema validation.
- Add new route/tool/message variants by editing a large central conditional.
- Hide external calls inside domain models.
- Log secrets, tokens, raw personal data, or full browser page data.
- Depend on implicit browser/service-worker memory state.
- Use `any`, untyped exceptions, untyped Python functions, unchecked JSON, or generated code without validation wrappers.
- Lack test coverage for error paths and permission/auth failures.
