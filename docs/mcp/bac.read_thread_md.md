# bac.read_thread_md

Read tool. Input `{ bac_id }`. Returns `{ path, content }` from the companion
`GET /v1/threads/{bac_id}/markdown` endpoint. Files larger than 10 MiB are
rejected by the companion to keep agent context bounded.
