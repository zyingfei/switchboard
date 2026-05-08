# Source compass artifact — Stage 4 collector framework

The full text of the external researcher's compass artifact (the design
contract for Stage 4) is preserved here for repo-internal reference.

The compass calls this "Stage 2 MVP." We've already shipped a Stage 2
(PR #105), so internally this feature is **Stage 4**. The compass section
numbers (2.A–2.G + Lock 5) are preserved verbatim because the structural
argument is what we want referenceable, not the stage number.

The companion plan-doc lives at
[`docs/proposals/stage-4-collector-framework.md`](../../docs/proposals/stage-4-collector-framework.md).

**Original source:** delivered by the researcher 2026-05-08 as
`compass_artifact_wf-6ee31198-b743-45db-a86d-0e49afa148d2_text_markdown.md`.
The full ~565-line artifact is maintained at the user's end; the spine
sections (2.A–2.G) and Lock 5 are quoted across the plan-doc and brief-doc
above. If the original artifact is needed verbatim during a code review,
ask the user for the source file.

## Key references that came from the compass

- **Tagged tuple identity** `(collector_id, event_type, payload_version)`.
- **FORWARD_TRANSITIVE compatibility** (Confluent schema-registry mode).
- **Textfile-collector pattern** (Prometheus `node_exporter`).
- **Three-axis SemVer** (Zed: `wasm_api_version` × `schema_version` ×
  extension `version`).
- **Linear upcaster pattern** (Greg Young / Marten / Axon /
  eventsourcing.readthedocs); Cambria lenses deferred.
- **JetBrains-style `since-build`/`until-build`** compatibility window.
- **Process-isolation discipline** (VS Code extension host) — adopted as
  "OS subprocess owned by the user, never spawned by companion."
- **Per-integration release cadence** (Datadog `integrations-core`).

## Out-of-band rejections (compass §"What to reject")

- Marketplace pattern.
- In-process plugin loading.
- WASM as the execution model.
- HTTP / MCP-RPC transports.
- Cambria-style bidirectional lenses in MVP.
- OpenTelemetry single-binary `ocb` build model.
- LLM-based session summarization in collectors.
- Time-proximity inferences across collectors.
