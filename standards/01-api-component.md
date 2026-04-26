# API Component Coding Standards

## Objective

API code must be contract-first, stable, extensible, secure, observable, and easy to evolve without breaking consumers.

## Contract standard

Use OpenAPI for HTTP APIs.

- Prefer OpenAPI **3.2.0** for new APIs if your validator, documentation, and codegen toolchain supports it.
- Use OpenAPI **3.1.x** if tooling compatibility is stronger. Avoid depending on 3.2-only features until the toolchain proves support.
- Keep one canonical contract per public API surface.
- Generate docs and client/server stubs only from the canonical contract.
- Validate contract changes in CI.

Minimum OpenAPI requirements:

- Stable `operationId` for every operation.
- `components.schemas` for reusable request/response models.
- Security schemes declared centrally.
- Error schema defined once and referenced everywhere.
- Request/response examples for public endpoints.
- Explicit `deprecated: true` plus migration guidance for deprecated operations.
- `tags` organized by domain capability, not by implementation class.

## Resource design

Use resource-oriented API design unless there is a strong reason not to.

Rules:

- Use nouns for resources: `/users/{userId}/sessions`, not `/getUserSessions`.
- Use plural collections: `/projects`, `/documents`.
- Use path parameters for identity and query parameters for filtering/sorting/pagination.
- Prefer PATCH for partial updates with a documented patch format.
- Prefer POST to create subordinate resources or commands that are not naturally idempotent.
- For long-running operations, create a job resource: `POST /exports -> 202 + /jobs/{jobId}`.
- For bulk operations, define explicit request/response item error semantics.
- Avoid leaking database identifiers unless they are stable public IDs.

## Versioning and compatibility

Compatibility is a product feature.

A non-breaking change may add:

- Optional request fields.
- Response fields consumers can ignore.
- New endpoints.
- New enum values only if clients are designed to tolerate unknown values.

Breaking changes include:

- Removing/renaming fields.
- Changing field type or semantics.
- Making optional fields required.
- Tightening validation unexpectedly.
- Removing enum values.
- Changing auth or permission requirements without migration.

Preferred strategy:

- Keep `/v1` stable for externally consumed APIs.
- Add new capabilities without changing existing semantics.
- Use deprecation windows for replacement endpoints.
- Publish migration notes.
- For internal APIs, still maintain consumer-driven contract tests.

## Error response standard

Use a consistent problem shape, compatible with `application/problem+json` where possible.

```json
{
  "type": "https://example.com/problems/validation-error",
  "title": "Validation failed",
  "status": 400,
  "detail": "One or more fields are invalid.",
  "instance": "/requests/01HX...",
  "code": "VALIDATION_ERROR",
  "correlationId": "01HX...",
  "errors": [
    { "path": "email", "message": "Must be a valid email address" }
  ]
}
```

Rules:

- Never return framework-default stack traces.
- Include machine-readable `code` values.
- Map internal error categories exhaustively.
- Do not overload `500` for dependency, timeout, quota, or validation issues.

## Idempotency and concurrency

- For non-idempotent create/payment/action endpoints, support idempotency keys.
- For mutable resources, support optimistic concurrency via resource version, ETag, or explicit revision field.
- Define retry-safe operations and document retry behavior.
- Treat duplicate requests as a production norm, not an edge case.

## Pagination, filtering, and sorting

Preferred cursor pagination:

```http
GET /items?limit=50&cursor=opaqueCursor
```

Response:

```json
{
  "data": [],
  "page": {
    "limit": 50,
    "nextCursor": "opaqueCursorOrNull"
  }
}
```

Rules:

- Define max page size.
- Cursor values must be opaque.
- Sorting fields must be allowlisted.
- Filtering semantics must be documented and tested.

## Security standards

- Authenticate at the boundary and authorize in application services.
- Keep authz decisions close to use cases, not only middleware.
- Validate request sizes and field limits.
- Apply rate limits by actor, IP, tenant, or API key as appropriate.
- Use least-privilege service credentials.
- Do not log authorization headers, cookies, tokens, or raw personal data.
- Enforce CORS by explicit allowlist.
- Protect state-changing endpoints from CSRF where browser cookies are used.

## Application architecture

Recommended structure:

```text
api/
  http/
    routes/
    controllers/
    middleware/
    serializers/
  application/
    commands/
    queries/
    handlers/
    policies/
  domain/
    models/
    services/
    events/
    errors/
  infrastructure/
    persistence/
    clients/
    auth/
    telemetry/
  composition-root/
```

Rules:

- Controllers only parse/validate input, call application services, and translate output/errors.
- Application services own transaction boundaries, authz policies, orchestration, idempotency, and integration with ports.
- Domain services enforce invariants without framework dependencies.
- Infrastructure code implements ports and is replaceable.

## Open/closed API implementation

Use registries and handlers.

Example conceptual model:

```ts
export interface CommandHandler<I, O> {
  readonly name: string;
  execute(input: I, ctx: RequestContext): Promise<O>;
}

export class CommandBus {
  private readonly handlers = new Map<string, CommandHandler<unknown, unknown>>();

  register(handler: CommandHandler<unknown, unknown>): void {
    if (this.handlers.has(handler.name)) throw new Error(`Duplicate handler: ${handler.name}`);
    this.handlers.set(handler.name, handler);
  }

  async execute<I, O>(name: string, input: I, ctx: RequestContext): Promise<O> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown command: ${name}`);
    return handler.execute(input, ctx) as Promise<O>;
  }
}
```

Adding a new command should register a new handler, not modify core orchestration.

## Observability standards

Every endpoint must define:

- Operation name: `api.<resource>.<action>`.
- Correlation/request ID propagation.
- Audit event when state, permissions, or sensitive data changes.
- Metrics: request count, latency, status class, error category.
- Dependency spans for database and external API calls.

## Testing standards

Required tests:

- Unit tests for domain invariants.
- Application-service tests with fake ports.
- HTTP contract tests against OpenAPI examples.
- Auth/authz failure tests.
- Validation tests for boundary schemas.
- Idempotency and retry tests for non-idempotent operations.
- Migration/compatibility tests for versioned endpoints.

## API review checklist

Use `checklists/api-design-review.md` for new endpoint approval.
