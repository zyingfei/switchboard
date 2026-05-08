# Work Graph Eval Pack

This pack documents the deterministic Stage 2/3 e2e fixture used by
`connections-stage2-3-user-story.spec.ts`.

The fixture is intentionally not based on arbitrary page titles. When
`SIDETRACK_TEST_EMBEDDER=1`, the test embedder maps these tokens to fixed
vector axes:

- `sidetrack_eval_postgres`
- `sidetrack_eval_kubernetes`
- `sidetrack_eval_negative`

Pages in the same token family should form predictable cosine
neighborhoods and topic components. The negative page is deliberately
outside those families so it remains a stable negative pair for feedback
and ranker retraining.

Continuation evidence is deterministic because the same canonical
Postgres visit is observed by two replica ids within minutes and both
replica-specific visit ids copy the same snippet hash. The deterministic
continuation scorer crosses threshold from same canonical URL, same
workstream, time proximity, and copy/paste lineage continuity.
