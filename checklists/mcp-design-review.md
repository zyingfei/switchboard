# MCP Design Review Checklist

Use this before adding or changing an MCP tool, resource, prompt, client, or transport.

## Protocol

- [ ] Protocol version is pinned and documented.
- [ ] Capability negotiation behavior is tested.
- [ ] The component uses only negotiated capabilities.
- [ ] Timeout and cancellation behavior is defined.
- [ ] Shutdown behavior is safe.

## Capability contract

- [ ] Tool/resource/prompt name is stable and namespaced.
- [ ] Input schema is explicit.
- [ ] Output schema is explicit where possible.
- [ ] Metadata includes description, version, owner, and permission policy.
- [ ] Duplicate registration is rejected.

## Tool-specific

- [ ] Side-effect classification is documented.
- [ ] User confirmation policy is defined.
- [ ] Idempotency behavior is defined for writes.
- [ ] Destructive actions require explicit confirmation.
- [ ] Tool output avoids leaking secrets or raw internal errors.

## Resource-specific

- [ ] URI scheme/pattern is stable.
- [ ] Access policy is explicit.
- [ ] Data sensitivity is classified.
- [ ] Pagination/cache/subscription semantics are defined where applicable.
- [ ] Resource URIs do not contain secrets.

## Prompt-specific

- [ ] Arguments are schema-validated.
- [ ] Prompt template has golden tests.
- [ ] Prompt change compatibility/deprecation is considered.
- [ ] Prompt does not embed secrets or environment-specific assumptions.

## Security

- [ ] Authentication is required where appropriate.
- [ ] Authorization is checked per invocation.
- [ ] Roots/filesystem boundaries are allowlisted.
- [ ] Remote HTTP transport validates Origin where relevant.
- [ ] Audit event emitted for sensitive reads/writes.

## Extensibility

- [ ] Capability added by module registration, not by editing core protocol loop.
- [ ] External dependencies are injected.
- [ ] Application/domain logic is independent of MCP SDK types.

## Tests

- [ ] Lifecycle tests.
- [ ] Schema validation tests.
- [ ] Permission-denied tests.
- [ ] Timeout/cancellation tests.
- [ ] Transport tests for stdio/HTTP mode used.
