# MCP Capability: bac.list_workstream_notes

## Purpose

Return Markdown notes whose frontmatter declares `bac_workstream: <id>`.

## Input

- `workstreamId: string` — target workstream `bac_id`.

## Output

Returns `{ items: LinkedNote[] }` from `GET /v1/workstreams/{id}/linked-notes`.

## Security And Failure Behavior

Requires companion URL and bridge key. Sidetrack records the link only; the scanner never parses note body content.
