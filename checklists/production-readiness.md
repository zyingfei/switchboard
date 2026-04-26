# Production Readiness Checklist

Use this before promoting any API/MCP/browser-plugin feature from POC-derived implementation to production.

## Product and behavior

- [ ] The useful behavior from the POC is captured in tests or examples.
- [ ] POC shortcuts are not copied into production architecture.
- [ ] Edge cases and failure modes are documented.
- [ ] Deprecation/migration impact is reviewed.

## Architecture

- [ ] Boundary schemas exist.
- [ ] Application/domain logic is framework-independent.
- [ ] External integrations are behind ports/adapters.
- [ ] New variants are added through extension points.
- [ ] Configuration is typed and injected.

## Security

- [ ] Least privilege enforced.
- [ ] Authentication and authorization reviewed.
- [ ] Secrets are not logged or persisted unsafely.
- [ ] Sensitive data is classified and redacted.
- [ ] Abuse cases are considered.

## Reliability

- [ ] Timeouts are configured.
- [ ] Retry behavior is safe.
- [ ] Cancellation is handled where applicable.
- [ ] Idempotency/concurrency is handled where applicable.
- [ ] Dependency failures are mapped to controlled errors.

## Observability

- [ ] Structured logs exist.
- [ ] Metrics exist.
- [ ] Tracing/correlation IDs exist.
- [ ] Audit events exist for sensitive or state-changing operations.
- [ ] Runbook/debug notes exist for critical features.

## Tests and CI

- [ ] Unit tests pass.
- [ ] Integration/contract tests pass.
- [ ] Typecheck/static analysis passes.
- [ ] Lint/formatter passes.
- [ ] Security/dependency checks pass.
- [ ] Build artifact is reproducible.
