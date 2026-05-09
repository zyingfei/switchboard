# Sidetrack — Stage 4 (Pluggable Collector Framework)

> **Status: scope locked 2026-05-08; spine + Codex CLI + Claude Code in scope
> for this PR.** Stage 4.1 (Shell + Git + GitHub collectors) is a follow-up
> PR. Stage 4.2 (rotation/archival, side-panel health metrics, write-your-own
> guide) is a follow-up follow-up.
>
> The external researcher's compass artifact called this "Stage 2." We've
> already shipped a Stage 2 (PR #105 work-graph ranker), so internally this
> feature is **Stage 4**. Compass section numbering (2.A–2.G + Lock 5) is
> preserved verbatim where cited so the structural argument stays referenceable.
>
> **Source compass artifact**: `design/stage-4-collector-framework/compass-source.md`.

## Northern star

The point of Stage 4 is not "we now ingest Codex and Claude transcripts." The
point is that **Sidetrack acquires a shape into which any new behavioral
signal source can be slotted without the companion, the plugin, or the relay
needing to know it exists in advance**. A collector is a small, independently
versioned process the user installs and trusts. It observes one source. It
writes append-only JSONL into a known directory. It never speaks to the
network. It never imports a Sidetrack runtime.

The companion treats a collector exactly the way the existing plugin is
treated by Sync Contract Class F — as a producer of bounded, opaque-until-
promoted records that pass through a single dedupe/promotion choke point on
their way into Class A. The five concrete collectors named in the compass
doc are conformance tests, not deliverables. **The framework is the
deliverable; collectors are conformance tests.**

If the spine is right, a sixth collector is writable in an afternoon by
someone who has never read the companion's source. If the spine is wrong,
every new collector becomes a coordinated cross-repo release. We are
optimizing relentlessly for the first outcome.

## Architectural locks

Locks 1–4 from Stage 1 stay invariant. Lock 5 is new for Stage 4.

- **Lock 1** (carry from Stage 1): `confidence` enum
  `{asserted, observed, inferred}`; CSS dashed for inferred edges.
- **Lock 2** (carry): every event payload carries `payloadVersion: number`
  and an open `dimensions: Record<string, unknown>`. Collector events extend
  `dimensions`; never the top-level shape.
- **Lock 3** (carry, extended): every Class B edge carries `producedBy`. A
  new `'collector'` variant is added to `ConnectionEdgeProducedBy` carrying
  `{ collector_id, event_type, payload_version, run_id }`. Class A event
  payloads use Lock 3's existing `producedBy.ruleId` slot with
  `"${collector_id}:${event_type}"`.
- **Lock 4** (carry): privacy gates as Class A facts. Collector capabilities
  in `collector.toml` map onto `privacy.permission.granted/.revoked` events
  with `permission: "collector.<id>.<capability>"`. The materializer reads
  gate state on every line; denial → quarantine; later grant → replay.
- **Lock 5 (NEW)**: three independent SemVer streams.
  - `payload_version` — integer, per `(collector_id, event_type)` tuple.
    Wire format snake_case; in-memory `currentPayloadVersion` to harmonize
    with `ContractEntry`.
  - `manifest_schema` — integer, per spine release.
  - `companion_framework_version` — SemVer, per companion release; **separate
    from `version.ts:COMPANION_VERSION`**. Bumps independently. Borrowed
    from Zed's split of `wasm_api_version` / `schema_version` / extension
    `version`.

## Architectural spine (compass §2.A–2.G)

### 2.A — Contract & schema versioning

Unit of contract is the **tagged tuple**
`(collector_id, event_type, payload_version)`. Every JSONL line carries all
three. The companion's job: look up a materializer for that tuple, run its
upcaster chain, validate with Zod, promote to Class A or quarantine.

**Compatibility mode: FORWARD_TRANSITIVE.** Producers (collectors) may
upgrade first. Consumers (companion materializer) MUST tolerate older
payloads indefinitely. Companion at framework version Y MUST accept any
`payload_version ∈ [1, max_known_to_Y(collector_id, event_type)]` and MUST
quarantine `payload_version > max_known_to_Y` — never crash, never silently
drop.

### 2.B — Registry & discovery

No central registry. No marketplace. The registry IS the local filesystem.
Companion scans `_BAC/collectors/<id>/collector.toml` on startup and watches
the directory at runtime. Manifest format is TOML, parsed via
`@iarna/toml`. Six-step load decision (parse → manifest_schema → companion
SemVer → vault major → all `[[emits]]` tuples have a registered materializer →
capabilities gateable).

`_BAC/collectors/` (vault-scoped) NOT `~/.sidetrack/` (compass doc choice):
per-vault isolation, uniform with audit/inbox/replica-id, deletes cleanly
with vault. Multi-vault users get per-vault collector configs.

### 2.C — Lifecycle & decoupled upgrade

Compatibility window bounded on both sides (JetBrains-style
`since-build`/`until-build`). Manifests outside refuse-to-load; events
outside quarantine. Rollback is filesystem-rollback. Partial rollout: Class A
events sync between replicas at different framework versions; raw collector
inboxes never sync.

### 2.D — Composition with Sync Contract Class A–F

**No new Class.** Inbox is Class C-equivalent (parallel to Class F semantics
but local-only). Read-time goes through a single
`materializeCollectorLine(line) → PromotionResult` choke point. Promoted
events go through `eventLog.appendServerObserved` (the existing Class A
choke). Class B / E pipeline downstream is unchanged.

### 2.E — Unknown event handling & quarantine

Quarantine path under `_BAC/audit/quarantine/<date>/<collector_id>.jsonl`
mirrors `auditRetention.ts:11-50` (25 MB / 90 days / gzip / MAX_ROTATIONS=12).
Replay-on-startup re-runs `materializeCollectorLine` on every quarantined
line; success → Class A with original `emitted_at`; still-fail → updated
`last_replay_at`. Never-drop policy.

### 2.F — Trust & capability boundaries

No new auth surface. The file-watch directory IS the trust boundary;
`_BAC/inbox/<id>/` mode 0700 (user-only). Capabilities → Class A privacy
facts (Lock 4). Default-off for sensitive collectors via
`default-enabled = false`.

### 2.G — Eight structural acceptance tests

| #  | Test                                                              | Type         |
|----|-------------------------------------------------------------------|--------------|
| 1  | Zero collectors → Stage 1 + Stage 2/3 e2e suite passes unmodified | regression   |
| 2  | One test-tick collector → 100 lines → 100 promoted + 100 audit + 0 quarantine | integration |
| 3  | `payload_version` ahead of companion → quarantine; replay on upgrade | integration |
| 4  | Privacy gate denied → quarantine; granted → replay               | integration |
| 5  | `requires-companion = ">=999.0.0"` → refuse + audit              | unit         |
| 6  | Two collectors with colliding `event_type` → distinct Class A events | integration |
| 7  | Collector-derived events feed connections + recall identically to plugin events | e2e |
| 8  | `find _BAC -type d -maxdepth 2` shows only documented layout    | unit         |

## Sub-task list

Detailed briefs in
[`stage-4-collector-framework-briefs.md`](./stage-4-collector-framework-briefs.md).

### Wave A — foundational

- **S1** Manifest TOML schema + Zod parse + load decision + `@iarna/toml` dep.
- **S2** `COLLECTOR_FRAMEWORK_VERSION` constant.
- **S3** Inbox + manifest path helpers + collector-id validation
  (`[a-z0-9.-]+`).
- **S4** Atomic-write helper extracted to `vault/atomic.ts`.
- **S5** Privacy event extension via existing
  `PRIVACY_PERMISSION_GRANTED/_REVOKED`.

### Wave B — runtime spine

- **S6** Audit-event subtypes (`route: "collector:<verb>"`).
- **S7** `MaterializerRegistration<P>` type + tuple-keyed lookup +
  `'collector'` in `KNOWN_MATERIALIZERS`.
- **S8** `'collector'` `ConnectionEdgeProducedBy` variant.
- **S9** Discovery scan + watch (six-step load decision).
- **S10** Tail loop with bookmark `{ filename, byte_offset, line_hash }` +
  60s rescan.
- **S11** `materializeCollectorLine()` choke point.
- **S12** Quarantine writer.
- **S13** Replay-on-startup.
- **S14** Quarantine retention.
- **S15** Wire framework startup into `runtime/companion.ts`.

### Wave C — collectors

- **S16** Synthetic `sidetrack.test-tick` collector + materializer for
  conformance tests #2/#3/#4/#6.
- **S17** `sidetrack.codex-cli` materializer (session_started v1 +
  session_turn v1).
- **S18** `sidetrack.claude-code` materializer (session_started v1 +
  session_turn v1).

### Wave D — lead-led

- **L1** Eight structural tests + Lock 5 invariants.
- **L2** Settings panel `CollectorsSection`.
- **L3** HTTP routes `GET /v1/collectors`, `POST /v1/collectors/{id}/replay`.
- **L4** `docs/adding-a-collector.md` + `design/stage-4-collector-framework/`.

## How this composes with Stage 1 / Stage 2/3

Every Stage 4 mechanism is a **second instance** of the existing plugin →
companion path:

| Plugin path | Collector path |
|---|---|
| `chrome.storage.local` queue | `_BAC/inbox/<id>/<date>.jsonl` |
| Plugin outbound spool | Collector atomic-write rotation |
| Plugin event ingester | Companion collector tail loop |
| Lock 2 `payloadVersion` + `dimensions` | Same Lock 2 (no new mechanism) |
| Bridge-key auth on loopback HTTP | Filesystem permissions on inbox dir |

Stage 1 connections discipline (evidence-first, deterministic, no
time-proximity inferences, no LLM recommendations) carries forward verbatim.
Stage 1 recall stack (e5-small + MiniSearch + RRF) ingests collector-derived
Class A events identically. Stage 2/3 LightGBM ranker sees collector events
as additional candidates with the same feature shape.

## Out of scope

- Shell, Git, GitHub collectors → Stage 4.1.
- Inbox archival/rotation, side-panel health metrics, write-your-own guide →
  Stage 4.2.
- Cross-collector synthetic events / Cambria lenses → Stage 4.3 if real need.
- IDE / calendar / meeting transcript collectors → deferred Appendices F+.
- Marketplace, central registry, auto-update.
- Companion-side process supervision.
- HTTP / MCP-RPC collector transports (locked out by user direction).
- LLM-based session summarization inside collectors.
- Time-proximity inference across collectors (Stage 1 lock).
- Per-collector secret-redaction layer.
- `fs.watch` recovery fine-tuning across all FS / OS combinations
  (implementation concern in S10).
- Collector binary distribution / install UX.
