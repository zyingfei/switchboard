# MCP Capability: bac.list_audit_events

## Purpose

Expose the companion audit ledger to coding agents for read-only inspection of recent bridge actions.

## Input

- `limit?: number` — integer 1..100, companion default is 20.
- `since?: string` — ISO-8601 timestamp filter.

## Output

Returns `{ data: AuditEvent[] }` without changing the companion audit record shape.

## Security And Failure Behavior

Requires `sidetrack-mcp` to be started with `--companion-url` and `--bridge-key`. If missing, the tool returns the same unavailable MCP error style as `bac.move_item`.
