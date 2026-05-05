# MCP Capability: bac.list_annotations

## Purpose

List persisted web annotations for coding agents.

## Input

- `url?: string` — filter annotations to an exact page URL.
- `limit?: number` — 1..100, default 100.

## Output

Returns `{ data: Annotation[] }` from `GET /v1/annotations`.

## Notes

Use with `bac.create_annotation` for term-scoped highlights that the extension
restores visually on the annotated page.
