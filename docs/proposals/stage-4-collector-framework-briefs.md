# Stage 4 — per-sub-task briefs

> Briefs for the spine + Codex CLI + Claude Code collectors. Each brief is
> self-contained: schemas, file paths, change shapes, test scenarios.
>
> Dependency graph is captured in the parent plan-doc
> ([`stage-4-collector-framework.md`](./stage-4-collector-framework.md)).
> Solo execution this PR — no Codex orchestration. The brief format is
> preserved for future Stage 4.1 / 4.2 dispatch.

---

## Wave A — foundational

### S1 — Manifest TOML schema + Zod parse + load decision

**Files:**
- `packages/sidetrack-companion/src/collectors/framework/manifest.ts` (NEW).
- `packages/sidetrack-companion/src/collectors/framework/compatibility.ts` (NEW).
- `packages/sidetrack-companion/src/collectors/framework/manifest.test.ts` (NEW).
- `packages/sidetrack-companion/package.json` (add `@iarna/toml` dep).

**Schema:** Zod schema mirrors compass §2.B example. Required: `id`, `name`,
`version`, `manifest_schema`, `[compatibility]`, `[[emits]]`, `[io]`,
`[capabilities]`, `[process]`. `id` matches `[a-z0-9.-]+`.

**Load decision (six fail-fast checks):** parse → manifest_schema range →
companion SemVer → vault major → emits-tuple-registered → capabilities-
gateable. Returns
`{ accepted: { manifest, warnings } } | { rejected: { reason, audit } }`.

**`compatibility.ts`:** SemVer parsing (handcrafted minimal — same shape
the runtime version comparator uses; no new dep). Range syntax matches
npm-style: `">=1.7.0 <3.0.0"`.

**Tests:** parse-success path; each rejection path; range satisfaction
edge cases (exact lower/upper, prerelease coercion).

### S2 — `COLLECTOR_FRAMEWORK_VERSION` constant

**Files:**
- `packages/sidetrack-companion/src/version.ts` (modify).
- `packages/sidetrack-companion/src/collectors/framework/version.ts` (NEW —
  re-export + Lock 5 doc).

**Shape:**
```ts
export const COMPANION_VERSION = '0.0.0';
export const COLLECTOR_FRAMEWORK_VERSION = '1.0.0';
```

`COLLECTOR_FRAMEWORK_VERSION` bumps independently of `COMPANION_VERSION`.
`MIN_MANIFEST_SCHEMA = 1`, `MAX_MANIFEST_SCHEMA = 1` for Stage 4.0.

### S3 — Inbox + manifest path helpers

**Files:**
- `packages/sidetrack-companion/src/vault/inbox.ts` (NEW).
- `packages/sidetrack-companion/src/vault/inbox.test.ts` (NEW — covers
  structural test #8).

**Helpers:**
- `inboxPathFor(vaultRoot, collectorId, date) → string`.
- `manifestPathFor(vaultRoot, collectorId) → string`.
- `quarantinePathFor(vaultRoot, collectorId, date) → string`.
- `bookmarkPathFor(vaultRoot, collectorId) → string`.
- `validCollectorId(s) → boolean` matching `^[a-z0-9][a-z0-9.-]*[a-z0-9]$`
  (no leading/trailing punctuation).

**Test #8:** `find _BAC -type d -maxdepth 2` over a fixture vault returns
exactly the documented layout: `inbox/`, `audit/`, `audit/quarantine/`,
`collectors/`, plus pre-existing Stage-1 dirs (`events/`, `threads/`,
`workstreams/`, `dispatches/`, `coding/`, `recall/`, `timeline/`, `.config/`).

### S4 — Atomic-write helper

**Files:**
- `packages/sidetrack-companion/src/vault/atomic.ts` (NEW).
- `packages/sidetrack-companion/src/vault/writer.ts` (modify — call shared).
- `packages/sidetrack-companion/src/sync/replicaId.ts` (modify — call shared).

**Shape:**
```ts
export const writeFileAtomic = async (path: string, body: string | Buffer):
  Promise<void> => { /* mkdir + writeFile temp + rename */ };
export const writeJsonAtomic = async (path: string, value: unknown):
  Promise<void> => writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
```

Reused by quarantine writer (S12), bookmark writer (S10), replica-id
bootstrap, and existing `writer.ts` settings/coding paths.

### S5 — Privacy event extension

**Files:**
- `packages/sidetrack-companion/src/collectors/framework/capabilityGates.ts`
  (NEW — emits `privacy.permission.granted/.revoked` Class A events with
  `permission: "collector.<id>.<capability>"`; reads gate state via
  `privacy/projection.ts`).
- No event-type changes — reuse `PRIVACY_PERMISSION_GRANTED/_REVOKED`.

**Justification:** keeping the event-type set stable means the registry
coverage test passes without modification, and the side panel's existing
privacy-gate UI handles the new gate keys uniformly.

---

## Wave B — runtime spine

### S6 — Audit-event subtypes

**Files:**
- `packages/sidetrack-companion/src/vault/writer.ts` (no schema change —
  `route` is already free-string; document the `"collector:<verb>"` namespace).
- `packages/sidetrack-companion/src/collectors/framework/audit.ts` (NEW —
  helper that wraps `audit({ route: "collector:<verb>", ... })`).

**Routes namespace:** `collector:line-read`, `collector:line-malformed`,
`collector:line-promoted`, `collector:line-quarantined`,
`collector:manifest-loaded`, `collector:manifest-too-new`,
`collector:manifest-too-old`, `collector:manifest-spawn-policy-unsupported`,
`collector:bookmark-advanced`.

### S7 — Materializer registry

**Files:**
- `packages/sidetrack-companion/src/collectors/framework/materializer.ts`
  (NEW). Defines `MaterializerRegistration<P>`, registry type,
  per-`(collector_id, event_type, payload_version)` lookup, upcaster chain
  composition.
- `packages/sidetrack-companion/src/sync/contract/registry.ts:110-116` —
  add `'collector'` to `KNOWN_MATERIALIZERS`.

**Type:**
```ts
type PayloadVersionStatus = 'current' | 'accepted' | 'quarantine-only';
interface MaterializerRegistration<P_current> {
  collector_id: string;
  event_type: string;
  current_payload_version: number;
  versions: Record<number, {
    status: PayloadVersionStatus;
    upcastTo?: (older: unknown) => unknown;
  }>;
  validate: (latest: unknown) => P_current;
  toClassA: (latest: P_current, env: CollectorEvent) => readonly ClassAEvent[];
}
```

### S8 — `'collector'` `ConnectionEdgeProducedBy` variant

**File:** `packages/sidetrack-companion/src/connections/types.ts:147-168`.

**Add 4th variant:**
```ts
| {
    readonly source: 'collector';
    readonly collector_id: string;
    readonly event_type: string;
    readonly payload_version: number;
    readonly run_id: string;
    readonly eventType?: never;
    readonly dot?: never;
    readonly recordId?: never;
    readonly revisionId?: never;
  }
```

Existing variants unchanged. Type-checker accepts both old and new variants.

### S9 — Discovery scan + watch

**File:** `packages/sidetrack-companion/src/collectors/framework/discovery.ts` (NEW).

Scan `_BAC/collectors/` on startup. Watch via `node:fs.watch({ recursive: true })`
on the same root with 200ms debounce (mirroring `vault/watcher.ts:46-91`).
Each `*/collector.toml` triggers the six-step load decision; result is
recorded in an in-memory `LoadedCollectorRegistry` plus an audit event.

### S10 — Tail loop with bookmark

**File:** `packages/sidetrack-companion/src/collectors/framework/tail.ts` (NEW).

**Bookmark format** (atomic-written via S4 to
`_BAC/inbox/<collector_id>/.bookmark.json`):
```json
{
  "filename": "2026-05-08.jsonl",
  "byte_offset": 12345,
  "line_hash_of_last_promoted": "<sha256>",
  "updated_at": "2026-05-08T..."
}
```

**Tail behavior:**
1. On startup: read bookmark; resolve to (file, offset). If file missing
   OR `byte_offset > size` OR previous-line hash mismatch → rescan from
   start, skipping lines whose `(collector_id, source_record_id)` is
   already in Class A.
2. Read incrementally on `fs.watch` notification; debounce 200ms.
3. Periodic 60s rescan as `fs.watch`-drop recovery.
4. Per line: call `materializeCollectorLine`. On `promoted/deduped` →
   advance bookmark. On `quarantined` → write quarantine FIRST, THEN advance
   bookmark.

### S11 — `materializeCollectorLine()` choke point

**File:** `packages/sidetrack-companion/src/collectors/framework/promote.ts`
(NEW).

Single function. Lookup materializer by tuple. Run upcaster chain. Validate
with Zod. Run `toClassA`. Append via `eventLog.appendServerObserved`. Stamp
`producedBy: { kind: "collector", ruleId: "${collector_id}:${event_type}",
ruleVersion: collector_version, runId: collector_run_id }` on every emitted
Class A event.

Reads privacy projection on every line — denied capability → quarantine
with reason `"privacy-gate-denied"`.

**Returns:**
```ts
type PromotionResult =
  | { kind: 'promoted'; events: readonly ClassAEvent[] }
  | { kind: 'quarantined'; reason: QuarantineReason; line: CollectorEvent }
  | { kind: 'deduped'; original_class_a_id: string }
  | { kind: 'dropped'; reason: DropReason };  // unused in MVP
```

### S12 — Quarantine writer

**File:** `packages/sidetrack-companion/src/collectors/framework/quarantine.ts` (NEW).

Append-only JSONL at `_BAC/audit/quarantine/<date>/<collector_id>.jsonl`.
Idempotent on `(collector_id, line_hash)` — re-quarantine of same line is
a no-op (read existing entries, dedup before append). Each entry:
```json
{
  "line": <original raw>,
  "quarantined_at": "...",
  "reason": "...",
  "companion_version": "...",
  "framework_version": "...",
  "last_replay_at": null
}
```

Audit subtype: `"collector:line-quarantined"`.

### S13 — Replay-on-startup

**File:** `packages/sidetrack-companion/src/collectors/framework/replay.ts` (NEW).

Scan `_BAC/audit/quarantine/` on startup AFTER manifest registry is loaded.
For each line: rebuild a `CollectorEvent` from the stored raw line; re-run
`materializeCollectorLine`; on `promoted` → emit Class A with the
*original* `emitted_at` (not replay time) AND remove from quarantine.
On still-failure → update `last_replay_at`. Emits audit
`"collector:line-promoted"` with `replay: true` annotation.

### S14 — Quarantine retention

**File:**
`packages/sidetrack-companion/src/collectors/framework/quarantineRetention.ts`
(NEW).

Mirror `vault/auditRetention.ts:11-50`: 25 MB / 90 days / gzip-rotated /
MAX_ROTATIONS=12. Run from `runtime/companion.ts` setInterval next to
`auditRetention`.

### S15 — Runtime wiring

**File:** `packages/sidetrack-companion/src/runtime/companion.ts:130-218`
(modify).

Insert framework startup between connections register (~line 218) and
recallLifecycle. **Order matters:**
1. replay-on-startup (S13).
2. discovery scan (S9).
3. tail loop start (S10).
4. quarantine retention setInterval (S14).

All have teardown registration in the existing `teardown.push(...)` pattern.

---

## Wave C — collectors

### S16 — `sidetrack.test-tick` synthetic collector

**Files:**
- `packages/sidetrack-companion/src/collectors/test-tick/materializers.ts` (NEW).
- `packages/sidetrack-companion/test/collectors/test-tick-collector/writer.ts`
  (NEW — fixture writer used by integration tests).

**Schema:**
- `event_type: "tick"`, `payload_version: 1`.
- Payload: `{ tick_index: number, message?: string }`.
- Lock 2 dimensions optional.

**Class A target:** new event-type `coding.tick.observed` registered in
`sync/contract/registry.ts` so it has a `ContractEntry`.
`toClassA` emits one Class A event per line.

**Test #2 driver:** writer writes 100 lines with `tick_index 0..99`.

### S17 — `sidetrack.codex-cli` materializer

**File:** `packages/sidetrack-companion/src/collectors/codex-cli/materializers.ts` (NEW).

**Tuples:**
- `session_started` v1: `{ session_id, started_at, cwd, model }`.
- `session_turn` v1: `{ session_id, turn_index, started_at, completed_at,
  model, prompt_text, response_text, tool_call_count, exec_command_count }`.
- `source_record_id` for `session_turn` = `${session_id}:${turn_index}`.

**Class A targets:**
- `coding.session.started` (NEW, registered in `sync/contract/registry.ts`).
- `coding.session.turn.observed` (NEW).

Both register a recall surface so prompt/response text indexes.

**Capabilities:** `reads-paths = ["~/.codex/sessions/", "~/.codex/history.jsonl"]`,
`reads-env = ["CODEX_HOME"]`, `reads-network = false`,
`default-enabled = true`.

### S18 — `sidetrack.claude-code` materializer

**File:** `packages/sidetrack-companion/src/collectors/claude-code/materializers.ts` (NEW).

**Tuples:**
- `session_started` v1: `{ session_uuid, project_encoded_path, started_at,
  cwd, git_branch? }`.
- `session_turn` v1: `{ session_uuid, message_uuid, started_at,
  completed_at, prompt_text, response_text, tool_call_count, tool_kinds,
  thinking_block_count }`.
- `source_record_id` for `session_turn` = `message_uuid`.

**Class A targets:** same `coding.session.started` /
`coding.session.turn.observed` event types as Codex CLI (compass §2.G test
#6 asserts `producedBy.ruleId` differs even for colliding event types).

**Capabilities:** `reads-paths = ["~/.claude/projects/", "~/.claude/history.jsonl"]`,
`reads-env = []`, `reads-network = false`, `default-enabled = true`.

---

## Wave D — lead-led

### L1 — Eight structural tests

**Files:**
- `packages/sidetrack-companion/test/collectors/spine.e2e.ts` (NEW —
  tests #2/#3/#4/#6).
- `packages/sidetrack-companion/test/collectors/manifest.test.ts` covers #5.
- `packages/sidetrack-companion/test/collectors/inbox.test.ts` covers #8.
- Lock 5 invariants added to
  `packages/sidetrack-companion/src/sync/contract/registry.test.ts`.
- Test #1 = regression check; existing Stage-1 + Stage-2/3 e2e suites pass
  unmodified.
- Test #7 = extension to existing
  `packages/sidetrack-extension/tests/e2e/connections-mvp-user-story.spec.ts`
  asserting collector-derived events show up in connections + recall.

### L2 — Settings UI `CollectorsSection`

**File:**
`packages/sidetrack-extension/entrypoints/sidepanel/components/CollectorsSection.tsx` (NEW).

Slots into `SettingsV2Sections.tsx`. Lists loaded manifests, capabilities
(with gate state), recent quarantine count per collector, last successful
materialization time. No write affordances in MVP — Stage 4.2 adds inline
gate-toggle.

### L3 — HTTP routes

**Files:**
- `packages/sidetrack-companion/src/http/server.ts` (modify).
- `packages/sidetrack-companion/src/http/schemas.ts` (modify).

**Routes:**
- `GET /v1/collectors` → `{ collectors: CollectorStatus[] }`.
- `POST /v1/collectors/{id}/replay` → re-runs replay for one collector.

### L4 — Documentation

**Files:**
- `docs/adding-a-collector.md` (NEW).
- `design/stage-4-collector-framework/compass-source.md` (NEW — copies the
  source compass artifact for repo-internal reference).
- `design/stage-4-collector-framework/COLLECTOR-BRIEF-TEMPLATE.md` (NEW —
  9-field template per parent plan).
- `docs/architecture.md` (modify — add collector framework section).
