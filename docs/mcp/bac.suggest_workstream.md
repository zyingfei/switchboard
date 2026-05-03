# MCP Capability: bac.suggest_workstream

## Purpose

Score likely workstreams for a tracked thread using lexical, vector, and link-neighborhood signals.

## Input

- `threadId: string`
- `limit?: number` — 1..20, default 5.

## Output

Returns `{ data: Suggestion[] }` from `GET /v1/suggestions/thread/{id}`. Suggestions are read-only and never auto-apply.

## Notes

Default threshold is `0.55`, tunable via `SIDETRACK_SUGGEST_THRESHOLD`.
