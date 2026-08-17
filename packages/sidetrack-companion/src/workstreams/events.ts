// Workstream log-event types.
//
//   workstream.upserted — register write of the whole record
//                          (created + updated collapse to one
//                          event type since both replace fields).
//   workstream.deleted  — tombstone. Concurrent later upserts
//                          revive (matches thread + review-draft
//                          discard semantics).

export const WORKSTREAM_UPSERTED = 'workstream.upserted' as const;
export const WORKSTREAM_DELETED = 'workstream.deleted' as const;

export type WorkstreamEventType = typeof WORKSTREAM_UPSERTED | typeof WORKSTREAM_DELETED;

export type WorkstreamPrivacy = 'private' | 'shared' | 'public';

export interface WorkstreamChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly checked: boolean;
}

export interface WorkstreamUpsertedPayload {
  readonly bac_id: string;
  readonly title: string;
  readonly parentId?: string;
  readonly privacy?: WorkstreamPrivacy;
  readonly screenShareSensitive?: boolean;
  readonly tags?: readonly string[];
  readonly children?: readonly string[];
  readonly checklist?: readonly WorkstreamChecklistItem[];
  readonly description?: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

export interface WorkstreamDeletedPayload {
  readonly bac_id: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasValidPayloadExtensionFields = (value: Record<string, unknown>): boolean =>
  (value['payloadVersion'] === undefined ||
    (typeof value['payloadVersion'] === 'number' && value['payloadVersion'] >= 1)) &&
  (value['dimensions'] === undefined || isRecord(value['dimensions']));

export const isWorkstreamUpsertedPayload = (value: unknown): value is WorkstreamUpsertedPayload =>
  isRecord(value) &&
  typeof value['bac_id'] === 'string' &&
  typeof value['title'] === 'string' &&
  hasValidPayloadExtensionFields(value);

export const isWorkstreamDeletedPayload = (value: unknown): value is WorkstreamDeletedPayload =>
  isRecord(value) && typeof value['bac_id'] === 'string' && hasValidPayloadExtensionFields(value);

// ---- workstream.prototype.generated ------------------------------------
//
// Prototype-lane offline generation (docs/plans/2026-08-16-category-
// flexibility-hyde.md §3). One event PER GENERATED/SELECTED PROTOTYPE TEXT —
// a workstream's generation batch is m=3-5 of these sharing the same
// `evidenceWatermark` + `generatedAt`. Point-in-time snapshot, modeled on
// `recall/events.ts`'s RecallServedCandidateSnapshot per the design doc: the
// exact text is captured so a bad batch is IDENTIFIABLE and the derived
// prototype_vec store is a pure replay (re-embed the persisted text — never a
// re-call of the generation engine) per the sync-contract recovery mode.
export const WORKSTREAM_PROTOTYPE_GENERATED = 'workstream.prototype.generated' as const;

export type WorkstreamPrototypeGeneratedEventType = typeof WORKSTREAM_PROTOTYPE_GENERATED;

export const PROTOTYPE_GENERATED_TEXT_MAX_LENGTH = 2000;
export const PROTOTYPE_ID_MAX_LENGTH = 128;
export const PROTOTYPE_SOURCE_EVIDENCE_MAX_COUNT = 64;

export interface PrototypeGeneratedSnapshot {
  readonly payloadVersion: 1;
  readonly prototypeId: string;
  readonly workstreamId: string;
  readonly generatedText: string;
  readonly embeddingSchemaVersion: number;
  readonly sourceEvidenceIds: readonly string[];
  // e.g. "apple-fm#reason=ok" or, for the zh/non-en selection fallback,
  // "evidence-selection#reason=zh-dominant" / "…#reason=mixed-en-zh" — always
  // present, never blank, so a health reader can tell HOW every standing
  // prototype text was produced without re-deriving it.
  readonly generatorModelId: string;
  readonly generatedAt: number;
  // 'generated' — an on-device engine wrote this text, conditioned on the
  // evidence excerpts in the prompt (never free invention).
  // 'selected'  — a REAL evidence excerpt (title/gist), embedded directly
  // with no generation step (ReDE-RF pattern). v1 used this only for the
  // zh/non-en-dominant fallback; v2 (§11) generalizes it to every
  // workstream's medoid tier (see `angle`) — 'selected' now means "this text
  // is verbatim member evidence", regardless of language.
  readonly method: 'generated' | 'selected';
  // Hash of the evidence corpus this batch was generated from — the join key
  // dirty-marking reads to decide "has this workstream's evidence changed
  // materially since the last batch". See prototypeGeneration.ts.
  readonly evidenceWatermark: string;
  // ---- v2 additive fields (docs/plans/2026-08-16-category-flexibility-
  // hyde.md §11 — prototype lane v2). Both OPTIONAL: absent on every v1 row,
  // never required by the validator, so old events keep validating byte-
  // identically. A reader that wants "how was this specific text produced"
  // treats an absent `angle` as a pre-v2 row (method alone is all v1 ever
  // recorded).
  //
  // 'medoid'            — method='selected'; one of the workstream's K
  //                        greedy-k-medoid representative real member texts
  //                        (prototypeMedoids.ts). The v2 default tier, ALWAYS
  //                        attempted for every workstream (English or not) —
  //                        the generalized ReDE-RF path.
  // 'synthetic-sibling' — method='generated'; the ONLY generation angle v2
  //                        keeps (register-matched, excerpt-style,
  //                        vocabulary-widening — see prototypeGeneration.ts's
  //                        SYNTHETIC_SIBLING_PROMPT). The expansion tier:
  //                        interpolates/bridges vocabulary the saved medoids
  //                        do not cover, boosted for sparse workstreams.
  readonly angle?: 'medoid' | 'synthetic-sibling';
  // The exact member canonicalUrl this text was drawn from — populated only
  // for angle='medoid' rows (a generated row has no single source member;
  // its provenance is the WHOLE evidence corpus, already covered by
  // `sourceEvidenceIds`). Point-in-time provenance down to the individual
  // page, per the brief's "provenance (member url, evidence watermark)".
  readonly sourceMemberUrl?: string;
}

const isStringArray = (value: unknown, maxLength: number): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= maxLength &&
  value.every((entry) => typeof entry === 'string' && entry.length > 0);

export const isPrototypeGeneratedSnapshot = (value: unknown): value is PrototypeGeneratedSnapshot =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  typeof value['prototypeId'] === 'string' &&
  value['prototypeId'].length > 0 &&
  value['prototypeId'].length <= PROTOTYPE_ID_MAX_LENGTH &&
  typeof value['workstreamId'] === 'string' &&
  value['workstreamId'].length > 0 &&
  typeof value['generatedText'] === 'string' &&
  value['generatedText'].length > 0 &&
  value['generatedText'].length <= PROTOTYPE_GENERATED_TEXT_MAX_LENGTH &&
  typeof value['embeddingSchemaVersion'] === 'number' &&
  isStringArray(value['sourceEvidenceIds'], PROTOTYPE_SOURCE_EVIDENCE_MAX_COUNT) &&
  typeof value['generatorModelId'] === 'string' &&
  value['generatorModelId'].length > 0 &&
  typeof value['generatedAt'] === 'number' &&
  Number.isFinite(value['generatedAt']) &&
  (value['method'] === 'generated' || value['method'] === 'selected') &&
  typeof value['evidenceWatermark'] === 'string' &&
  value['evidenceWatermark'].length > 0 &&
  (value['angle'] === undefined || value['angle'] === 'medoid' || value['angle'] === 'synthetic-sibling') &&
  (value['sourceMemberUrl'] === undefined ||
    (typeof value['sourceMemberUrl'] === 'string' && value['sourceMemberUrl'].length > 0));
