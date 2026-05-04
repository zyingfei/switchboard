# bac.bump_workstream

Write tool. Input `{ bac_id }`. Marks a workstream recently active by setting
`lastBumpedAt` through `POST /v1/workstreams/{bac_id}/bump`. Idempotent.
