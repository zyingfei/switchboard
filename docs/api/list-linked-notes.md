# API Endpoint: GET /v1/workstreams/{id}/linked-notes

## Purpose

List human-authored Markdown notes that opt into a Sidetrack workstream link through frontmatter.

## Request

Path parameter:

- `id` — workstream `bac_id`.

## Response

```json
{
  "items": [
    {
      "workstreamId": "bac_ws_...",
      "notePath": "relative/path.md",
      "title": "Note title",
      "updatedAt": "2026-04-26T22:00:00.000Z"
    }
  ]
}
```

## Security And Failure Behavior

Requires `x-bac-bridge-key`. The scanner reads Markdown frontmatter only, ignores note bodies, skips `_BAC/`, hidden paths, symlinks, malformed frontmatter, and files larger than 1 MiB.
