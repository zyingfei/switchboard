# MCP Component Coding Standards

## Objective

MCP components must expose tools, resources, and prompts as safe, typed, observable, least-privilege capabilities. The implementation must be protocol-compliant, capability-negotiated, and extensible through explicit capability modules.

## Protocol baseline

- Pin the MCP protocol version used by each client/server package.
- Prefer the latest specification your target clients support.
- Treat protocol version negotiation and capability negotiation as first-class behavior.
- Never call or expose a capability that was not negotiated.
- Implement request timeouts, cancellation handling, and graceful shutdown.
- Keep protocol transport code separate from capability implementation code.

## Component types

### MCP server

A server exposes capabilities:

- **Tools** for model-invoked actions.
- **Resources** for model-readable context and data.
- **Prompts** for reusable templates/workflows.

### MCP client

A client connects host applications to servers and may expose client-side capabilities such as roots, sampling, and elicitation. Client code must isolate each server connection and avoid sharing auth/session state across servers unless explicitly designed.

## Recommended architecture

```text
mcp/
  protocol/
    transport/
    lifecycle/
    negotiation/
    json-rpc/
  capabilities/
    tools/
    resources/
    prompts/
  application/
    use-cases/
    policies/
  domain/
  infrastructure/
    clients/
    persistence/
    auth/
    telemetry/
  composition-root/
```

Rules:

- Protocol handlers parse MCP messages and delegate to capability registries.
- Capability handlers call application services; they do not directly call databases, browser APIs, shell commands, or external SDKs.
- Tool/resource/prompt definitions live beside their handler and schema.
- Shared services are injected into capability modules.

## Capability module standard

Each MCP capability must be registered through a module.

Conceptual TypeScript shape:

```ts
export interface McpCapabilityModule {
  readonly id: string;
  readonly version: string;
  register(registry: McpRegistry, deps: McpModuleDependencies): void;
}

export interface McpRegistry {
  registerTool(definition: ToolDefinition, handler: ToolHandler): void;
  registerResource(definition: ResourceDefinition, handler: ResourceHandler): void;
  registerPrompt(definition: PromptDefinition, handler: PromptHandler): void;
}
```

Rules:

- A new tool/resource/prompt adds a module or handler; it does not modify the core MCP server loop.
- Registries reject duplicate names/URIs.
- Registries validate schemas at startup.
- Modules declare required policies, permissions, and external dependencies.

## Tool standards

Tools are high-risk because they can perform actions.

Every tool must define:

- Stable tool name.
- Human-readable title/description.
- Input schema.
- Output schema where possible.
- Side-effect classification: read-only, idempotent write, non-idempotent write, destructive.
- Required permissions/scopes.
- Required user-confirmation policy.
- Timeout and cancellation behavior.
- Audit event emitted on invocation.

Rules:

- Tool names should be namespaced: `calendar.create_event`, `repo.search_files`, `browser.extract_selection`.
- Tool descriptions must be accurate and not overpromise behavior.
- Tool inputs must be narrow and bounded.
- Prefer typed structured output over unstructured text.
- For writes, support idempotency keys when practical.
- For destructive actions, require explicit confirmation and log an audit event.
- Treat tool metadata and annotations as untrusted when received from outside your controlled server.

## Resource standards

Every resource must define:

- Stable URI scheme/pattern.
- MIME type.
- Data sensitivity classification.
- Access policy.
- Cacheability and freshness semantics.
- Pagination semantics for large data.
- Subscription behavior if supported.

Rules:

- Resource URIs must not contain secrets or bearer tokens.
- Do not expose broad filesystem or database access through generic resources.
- Make resource boundaries explicit through roots and allowlists.
- Redact sensitive data before returning resource content.

## Prompt standards

Prompts should be stable templates, not hidden business logic.

Every prompt must define:

- Name and purpose.
- Arguments with schema and defaults.
- Output message structure.
- Safety notes and expected model behavior.
- Versioning or deprecation plan when prompts change semantics.

Rules:

- Do not embed secrets or environment-specific data in prompt templates.
- Keep prompts deterministic enough to test with golden examples.
- Treat prompt arguments as untrusted input.

## Transport standards

### stdio

Use stdio for local development, CLI-style servers, and trusted local integrations.

Rules:

- Do not write non-protocol logs to stdout.
- Send diagnostic logs to stderr or structured logging sinks.
- Handle client shutdown cleanly.
- Ensure local process permissions are least-privilege.

### Streamable HTTP

Use Streamable HTTP for remote or multi-client deployment.

Rules:

- Validate `Origin` on incoming browser-capable connections.
- Bind local development servers to localhost unless intentionally exposed.
- Require authentication for remote servers.
- Support protocol-version headers as required by negotiated version.
- Design for multiple client connections.
- Treat SSE streams as unreliable long-lived channels; implement timeouts and reconnection behavior.

## Auth and authorization

- Authenticate clients before exposing sensitive capabilities.
- Authorize each tool/resource/prompt invocation, not just connection establishment.
- Use capability-scoped tokens or sessions where possible.
- Keep tenant/user identity in invocation context.
- Fail closed when identity, permissions, or capability negotiation is unclear.

## Safety and consent

- Human approval is required for tools that mutate state, access sensitive data, or trigger external side effects.
- Show users what tool is being called and why when the host UI supports it.
- Do not hide destructive behavior inside harmless-looking tool names.
- Provide dry-run or preview modes for risky tools.

## Error handling

Map application errors to MCP/JSON-RPC errors at the protocol boundary.

Rules:

- Do not leak stack traces or secrets.
- Return validation failures with actionable field-level messages where possible.
- Distinguish tool execution failure from protocol failure.
- Propagate cancellation and timeout events cleanly.

## Observability

Every MCP invocation should emit:

- Trace/span: `mcp.tool.<name>`, `mcp.resource.<name>`, `mcp.prompt.<name>`.
- Invocation ID and correlation ID.
- Protocol version and transport.
- Capability name/version.
- User/tenant identity when available.
- Outcome, latency, error category.
- Audit event for sensitive reads and writes.

## Testing standards

Required tests:

- Protocol lifecycle tests: initialize, capability negotiation, initialized, shutdown.
- Capability registry tests: duplicate names, schema validation, missing permission metadata.
- Tool input/output schema tests.
- Auth/authz failure tests.
- Timeout, cancellation, and dependency failure tests.
- Golden tests for prompt templates.
- Resource URI parsing and redaction tests.
- Transport tests for stdio/HTTP behavior used by the component.

## MCP review checklist

Use `checklists/mcp-design-review.md` for new MCP capabilities.
