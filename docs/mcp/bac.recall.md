# MCP Capability: bac.recall

## Purpose

Run read-only vector recall over captured turns indexed by the companion.

## Input

- `query: string`
- `limit?: number` — 1..50, default 10.
- `workstreamId?: string` — optional filter to threads assigned to a workstream.

## Output

Returns `{ data: RankedItem[] }` from `GET /v1/recall/query`.

## Notes

Embeddings and the rebuildable index live in the companion. No extension UI surface ships with this capability.
