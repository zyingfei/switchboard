# API Design Review Checklist

Use this before implementing or approving a new API endpoint.

## Contract

- [ ] OpenAPI contract updated.
- [ ] `operationId` is stable and descriptive.
- [ ] Request schema exists and validates all inputs.
- [ ] Response schema exists for success and errors.
- [ ] Examples are provided for public endpoints.
- [ ] Error responses use the standard problem shape.
- [ ] Endpoint is tagged by domain capability.

## Design

- [ ] Resource path uses nouns and stable public IDs.
- [ ] Versioning/compatibility impact is understood.
- [ ] Pagination/filtering/sorting semantics are documented if applicable.
- [ ] Idempotency behavior is defined for create/action endpoints.
- [ ] Optimistic concurrency is defined for mutable resources.
- [ ] Long-running operation pattern uses job resource or async channel.

## Security

- [ ] Authentication requirement is explicit.
- [ ] Authorization policy is implemented in application service.
- [ ] Rate limit/quota behavior is defined.
- [ ] Sensitive data is redacted in logs and errors.
- [ ] CORS/CSRF impact is reviewed where relevant.

## Extensibility

- [ ] New behavior plugs into handler/strategy/registry/event pipeline.
- [ ] Core routing/orchestration does not need repeated modification for future variants.
- [ ] Domain model does not depend on framework or persistence code.

## Operations

- [ ] Trace/span name defined.
- [ ] Metrics defined.
- [ ] Audit event defined for state/sensitive-data changes.
- [ ] Timeout/retry/dependency failure behavior defined.

## Tests

- [ ] Unit tests for domain/application logic.
- [ ] Contract tests for request/response examples.
- [ ] Validation failure tests.
- [ ] Auth/authz failure tests.
- [ ] Idempotency/concurrency tests where applicable.
