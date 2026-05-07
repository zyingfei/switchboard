# Extraction revisions (Class E)

The extraction layer sits between the immutable capture event log and
every downstream consumer (recall, context-pack, Obsidian, MCP, future
summaries). It is **the** canonical evolving interpretation of source
observations. Recall is one consumer; it is not the owner.

Read [`sync-contract-v1.md`](sync-contract-v1.md) first.

## The three layers

```text
source observation events  (immutable; the event log)
  e.g. capture.recorded, capture.extraction.produced

       │
       ▼

extraction revisions       (versioned interpretations)
  e.g. extract_chatgpt_v3_<hash>, extract_chatgpt_v4_<hash>

       │
       ▼

derived consumers          (per-consumer chunking + indexing)
  recall index, context-pack, Obsidian, MCP, summaries
```

These are **three different things**:

- A **source observation** is the raw evidence captured at a point in
  time (the JSON the plugin posts to `/v1/events`).
- An **extraction revision** is one named, versioned interpretation of
  that evidence (one extractor at one version, with one schema, one
  chunker).
- A **derived consumer entry** (e.g. a recall chunk) is what falls out
  of running the extractor + chunker over the active extraction
  revision.

A single source observation can have **many** extraction revisions
over time. Only one is **active** at any given moment, chosen by the
deterministic active-revision policy.

## Source unit identity

A `sourceUnitId` is the stable identity for one ChatGPT / Claude /
Gemini turn (or future provider unit):

```ts
type SourceUnitId =
  | `turn:${ProviderId}:${ConversationId}:${MessageId}`
  | `turn:${ProviderId}:${CanonicalUrl}:${Role}:${TurnOrdinal}:${SourceSnapshotHash}`;
```

The structured form is preferred when stable IDs are exposed by the
provider. The canonical-URL fallback is used when only the URL +
ordinal + content hash is available. The minter is at
`packages/sidetrack-companion/src/recall/extraction/types.ts` →
`sourceUnitIdFor`.

`sourceUnitId` carries through every revision, every chunk, and every
recall index entry. Cross-replica sync of an extraction upgrade
re-binds to the same `sourceUnitId` so the new revision replaces the
old one for every consumer.

## Extraction store on disk

```text
_BAC/extractions/
  sources/<sourceUnitId>.json           ← active revision pointer + status + history
  revisions/<extractionRevisionId>.json ← full revision content (one file per revision)
  state.json                             ← cross-source planner output (optional)
```

`sources/<sourceUnitId>.json` has the shape:

```json
{
  "sourceUnitId": "turn:chatgpt:abc:msg_42",
  "sourceBacId": "thread_xyz",
  "latestExtractionRevision": "extract_chatgpt_v4_<hash>",
  "indexedExtractionRevision": "extract_chatgpt_v3_<hash>",
  "status": "stale",
  "history": [
    {
      "extractionRevisionId": "extract_chatgpt_v4_<hash>",
      "extractorId": "chatgpt",
      "extractorVersion": "1.4.0",
      "createdAt": "2026-05-07T12:34:56.000Z",
      "extractionSchemaVersion": 2,
      "producerDot": { "replicaId": "replica-A", "seq": 17 }
    },
    { "...": "earlier revisions, bounded to last 20" }
  ]
}
```

The divergence

```
latestExtractionRevision != indexedExtractionRevision
```

is **the** durable signal that recall (or any other consumer) is
stale. Recall's `catchUp` scans for this divergence and source-replaces
its index — independent of whether a notification ever fired.

History entries carry **all** the inputs the active-revision policy
needs (`extractionSchemaVersion`, `producerDot`, semver, capability
score), so the policy can decide a winner from the source-state file
alone, without reading every revision file.

## Active-revision policy

When multiple revisions exist for one `sourceUnitId`, the policy in
`packages/sidetrack-companion/src/recall/extraction/manifest.ts` →
`selectActiveRevision` picks one **deterministically**:

```
1. Drop tombstoned revisions.
2. Prefer higher extractionSchemaVersion.
3. Prefer higher extractor manifest semver.
   Use proper semver compare — v1.10 > v1.2.
4. If still incomparable (different extractorId), prefer the higher
   capability score.
   Capabilities are declared tags: code-blocks, citations, attachments,
   model-name, image-alt, table-of-contents, …
5. Tie-break by (replicaId, dot.seq) deterministically.
```

The policy is pure — given the same input it returns the same winner
on every replica. This is what makes cross-replica extraction
upgrades deterministic (gate L2-G5).

## Causal vs policy supersede

Two distinct mechanisms:

- **Causal supersede (safety).** A new event whose `deps` include the
  prior dot causally dominates it. Prevents stale-browser-outbox
  edits from overwriting unobserved peer edits. Enforced by the
  causal CRDT layer.
- **Policy supersede (capability).** Two concurrent revisions for one
  source: causally incomparable. The active-revision policy picks one
  by its declared capabilities. The non-winners stay in `revisions/`
  for provenance — they never silently disappear.

## Capture path

```text
capture.recorded event
       │
       ▼
extractionMaterializer.onAccepted
  - Wraps the raw capture as a "legacy extraction revision"
    (extractor: 'legacy', version: 0.0.0, schema: 1).
  - putRevision(revision) — durable write to revisions/.
  - Reads source state, appends to history (bounded last 20 entries).
  - Runs selectActiveRevision over the history candidates.
  - Updates pointer + status in sources/<sourceUnitId>.json.
       │
       ▼
recallMaterializer.onAccepted (separately registered for capture.recorded)
  - Sets dirty bit; coalesced single drainer runs ingestIncremental.
       │
       ▼
recallMaterializer.catchUp also runs reconcileExtractionStaleSources
  on every startup + reconnect — finds divergent sources, source-
  replaces via replaceEntriesForSourceUnit.
```

## Cross-replica upgrade path

`capture.extraction.produced` is the event a replica emits when it
has computed a fresher extraction revision for an existing
`sourceUnitId`:

```text
Replica A captures turn T1 with chatgpt extractor v1.0  →  capture.recorded
Replica B has the chatgpt extractor at v1.4
Replica B receives the imported capture.recorded for T1
Replica B re-extracts T1 with v1.4 (live or stored evidence) →  capture.extraction.produced
       │
       ▼
Replay relay accepts capture.extraction.produced
       │
       ▼
Replica A imports capture.extraction.produced
  - Runs through the extractionMaterializer.
  - putRevision writes the v1.4 revision under revisions/.
  - History gains the v1.4 entry; selectActiveRevision picks v1.4.
  - sources/<sourceUnitId>.json now points latestExtractionRevision
    at v1.4; status flips to stale.
  - recallMaterializer.catchUp sees the divergence → source-replace.
       │
       ▼
Replica A's recall returns v1.4 chunks even though A has never
loaded chatgpt.com (gate L2-G8).
```

This solves the no-login peer recall case: a peer can use a fresher
extractor without ever needing the source provider's credentials.

## Stored vs live re-extraction

When an extractor upgrades, planner classifies each source:

- **current** — already at the latest version. Skip.
- **stored-reextract** — the captured evidence in
  `capture.recorded.payload.content` is sufficient to re-extract
  without revisiting the source. Fast path.
- **live-provider** — the captured evidence lacks fields the new
  extractor needs (e.g. an old capture without `markdown` or
  `formattedText`). Live revisit is required; defer until the user
  next visits that thread on the live provider.
- **not-upgradeable** — neither path will work (e.g. capture predates
  the extractor entirely and the source is no longer reachable).
  Recall keeps the legacy chunks; planner reports the count
  honestly.

The planner never silently triggers a full rebuild. Source-scoped
re-extract is the rule; full rebuild is the explicit emergency path.

## `replaceEntriesForSourceUnit` — the no-rebuild primitive

```ts
// packages/sidetrack-companion/src/recall/indexFile.ts
export const replaceEntriesForSourceUnit = async (
  indexPath: string,
  input: {
    sourceUnitId: string;
    extractionRevisionId: string;
    entries: IndexEntry[];
  },
  modelId: string,
): Promise<{ removed: number; inserted: number }>
```

Atomic via `.tmp + rename`. Removes every existing index entry that
carries the given `sourceUnitId`, inserts the new ones, advances the
per-source frontier, updates `indexedExtractionRevision` in the
extraction store. No full-index rewrite for ordinary upgrades.

## Embedding cache by `embedTextHash`

The chunker emits two strings per chunk:

- `chunk.text` — the raw turn content used for display, snippet
  rendering, and lexical (MiniSearch) matching.
- `chunk.embedText` — heading-breadcrumb-prefixed input that the
  embedder ACTUALLY sees.

Cache by the embedder input:

```ts
const embedTextHash = sha256(chunk.embedText).slice(0, 32);
const key = { modelId, modelRevision, embedTextHash };
const cached = await cache.get(key);
if (cached !== null) return cached;
const vector = (await embed([chunk.embedText]))[0];
await cache.put(key, vector);
return vector;
```

**Do not key by `chunk.text` or `chunk.textHash`.** A heading rename
or a chunker breadcrumb change would otherwise reuse a stale vector
for an input the embedder has never actually seen.

The cache is a write-through wrapper around an on-disk store and is
not a correctness-critical surface — a cache miss means the embedder
runs once more. But a stale-vector hit is a silent correctness bug,
so the key must reflect what was embedded.

## Subtleties

- **History is bounded to last 20 entries.** This is a per-source-state
  cap; older revisions remain in `revisions/` (the file store), they
  just leave the per-source policy candidate list. Twenty is enough
  for a few extractor upgrades; if we ever need more, raise the cap
  in the source state schema (it is already optional/forward-compat).
- **Per-source serialization.** The materializer serializes
  read-modify-write of one `sources/<sourceUnitId>.json` via a
  per-`sourceUnitId` promise queue. Different sources still run in
  parallel. Without this, two concurrent events for the same source
  race and lose history entries.
- **`extractionRevisionId` is content-derived.** Same input + same
  extractor + same version + same schema produces the same id.
  Important for archive import idempotency (gate L3-G7).

## Failures + recovery

| Failure | Effect | Recovery |
|---|---|---|
| Crash mid-`putSourceState` | `.tmp` cleanup on next startup | atomic write — partial files are never visible |
| Crash between `putSourceState` and recall ingest notification | extraction store now ahead of recall index | recall's `catchUp` reads the divergence and source-replaces (gate L2-G10) |
| Embedder offline | extraction revision still produced; recall ingest fails health-visibly | next startup with embedder online, `catchUp` re-runs |
| Concurrent revisions for same source | both written to `revisions/`; policy picks one as active | non-winners remain in `revisions/` for provenance |
| Stale browser outbox emits old revision | accepted as concurrent; policy decides | old revision does not dominate (gate L1-G7) |

## Pointers

- Source-of-truth code:
  - `packages/sidetrack-companion/src/recall/extraction/types.ts` —
    types + `sourceUnitIdFor`.
  - `packages/sidetrack-companion/src/recall/extraction/store.ts` —
    on-disk store API.
  - `packages/sidetrack-companion/src/recall/extraction/manifest.ts`
    — `selectActiveRevision` policy.
  - `packages/sidetrack-companion/src/sync/contract/extractionMaterializer.ts`
    — Class E materializer.
  - `packages/sidetrack-companion/src/recall/indexFile.ts` —
    `replaceEntriesForSourceUnit`.
- Tests covering this layer:
  - `extractionMaterializer` colocated tests.
  - `crossReplicaExtraction.test.ts`, `extractionRecallReconcile.test.ts`,
    `embeddingCacheReuse.test.ts`, `extractionConcurrency.test.ts`.
