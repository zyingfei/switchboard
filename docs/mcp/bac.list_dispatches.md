# MCP Capability: bac.list_dispatches

## Purpose

Expose companion-recorded dispatch events to coding agents through the same bridge-authenticated localhost API used by Sidetrack clients.

## Input

- `limit?: number` — integer 1..100, companion default is 20.
- `since?: string` — ISO-8601 timestamp filter.

## Output

Returns `{ data: DispatchEventRecord[] }` without changing the companion record shape.

## Security And Failure Behavior

Requires `sidetrack-mcp` to be started with `--companion-url` and `--bridge-key`. If missing, the tool returns the same unavailable MCP error style as `bac.move_item`.
