# M1 Standards Check

Status: production-package smoke evidence for PR #13 implementation work.

## Production Readiness

- [x] Useful PoC behavior is captured in tests: local bridge auth/queue, provider DOM extraction, generic fallback, MCP vault reads and stdio.
- [x] PoC code was promoted through package boundaries instead of copied as an unstructured bundle.
- [x] Failure modes are surfaced for companion down, vault unavailable, selector fallback, queue replay, and restorable tabs.
- [ ] Deprecation/migration impact: no existing production package to migrate.

## Architecture

- [x] Boundary schemas exist: companion Zod/OpenAPI, extension typed messages, MCP Zod tool inputs.
- [x] External integrations are behind adapters: companion HTTP client, storage port/queue, vault writer/reader.
- [x] Configuration is typed and injected: companion `--vault`/`--port`, extension companion settings, MCP `--vault`.
- [x] New provider variants plug into provider config registry.

## Security

- [x] Companion binds loopback and rejects non-local hosts/origins except Chrome extension origins.
- [x] `x-bac-bridge-key` protects all non-health routes.
- [x] Extension uses `activeTab`, storage, sidePanel, and optional host permissions.
- [x] Provider capture avoids form-control values and records warnings for sensitive-looking visible text.
- [ ] Full redaction/dispatch safety chain remains M2 by scope.

## Reliability and Observability

- [x] Capture queue is bounded at 1000 items with oldest eviction and replay.
- [x] `POST /v1/events` and `POST /v1/queue` persist idempotency records.
- [x] Companion writes audit JSONL entries for vault mutations.
- [x] HTTP responses include request/correlation IDs.
- [ ] Metrics/tracing backend is not wired in M1; structured audit/log fields are the local-first evidence.

## API Design Review

- [x] `packages/sidetrack-companion/docs/api/m1-endpoints.md` is present.
- [x] `packages/sidetrack-companion/openapi.yaml` is present and lints against `configs/openapi/api-style-rules.yaml`.
- [x] Error responses use `#/components/schemas/Problem`.
- [x] Idempotency is implemented for event and queue creates.
- [x] CORS preflight is covered for Chrome extension callers.
- [x] Auth failure, validation, idempotency, write, and vault-unavailable tests exist.

## Browser Plugin Review

- [x] Content script handles DOM capture only.
- [x] Background owns privileged browser APIs, companion calls, and queue replay.
- [x] Side panel uses typed runtime messages.
- [x] Provider extractor fixture tests cover ChatGPT, Claude, Gemini, unknown fallback, structured Markdown, and private form controls.
- [x] Build smoke verifies a loadable MV3 output.
- [ ] Full Playwright real-browser provider pass is still manual/pending.

## MCP Design Review

- [x] Tool names are stable and namespaced under `bac.*`.
- [x] Tools are read-only in M1.
- [x] Tool inputs are Zod schemas.
- [x] MCP reader stays inside `_BAC` live-vault directories.
- [x] Stdio integration test verifies tool listing, context pack, and search.

## Verification Commands

Last local smoke run:

- `packages/sidetrack-companion`: lint, typecheck, test, build, OpenAPI lint.
- `packages/sidetrack-extension`: lint, typecheck, test, build, e2e build smoke.
- `packages/sidetrack-mcp`: lint, typecheck, test, build.

Residual manual acceptance:

- Install the built extension in Chrome and exercise live ChatGPT, Claude, and Gemini pages.
- Confirm real provider assistant-turn auto-capture timing under 30 seconds.
- Confirm provider permission prompts and per-site disable behavior in a real profile.
