# bac.read_workstream_md

Read tool. Input `{ bac_id }`. Returns `{ path, content }` from the companion
`GET /v1/workstreams/{bac_id}/markdown` endpoint. Raw Markdown writes are
deliberately deferred until round-trip safety is designed.
