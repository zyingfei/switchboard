import { createHash } from 'node:crypto';
import { CAPTURE_RECORDED, isCaptureRecordedPayload } from '../events.js';
import { sourceUnitIdFor, } from './types.js';
// Sync Contract v1 / Class E — Lane 2 stage 3.
//
// Wraps an existing `capture.recorded` event as a legacy extraction
// revision. This makes recall a CONSUMER of the extraction store
// without changing the wire format of capture events. New extractor
// versions emit `capture.extraction.produced` (Lane 2 stage 6); for
// every existing capture in the merged log, we synthesize a
// "legacy" revision so the extraction store has a complete picture.
//
// Properties:
//   - Pure function of (event, replicaId). Same input → same revision id.
//   - Idempotent. Same event wrapped twice = same revision.
//   - extractorId='legacy', extractorVersion='0.0.0'. Any newer
//     revision dominates by the active-revision policy in
//     activeRevisionPolicy.ts (Lane 2 stage 4).
export const LEGACY_EXTRACTOR_ID = 'legacy';
export const LEGACY_EXTRACTOR_VERSION = '0.0.0';
export const LEGACY_EXTRACTION_SCHEMA_VERSION = 1;
export const LEGACY_CHUNKER_VERSION = 'legacy';
const sha256 = (input) => createHash('sha256').update(input).digest('hex');
const stableJson = (value) => {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys
        .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
        .join(',')}}`;
};
// Pure function: returns null when the event is not a
// capture.recorded (caller should ignore non-capture events).
// Returns one ExtractionRevision per turn — each turn gets its own
// sourceUnitId, so the source-scoped replace primitive can update
// individual turns without disturbing other turns of the same
// thread.
export const wrapCaptureAsLegacyRevisions = (event) => {
    if (event.type !== CAPTURE_RECORDED)
        return [];
    if (!isCaptureRecordedPayload(event.payload))
        return [];
    const payload = event.payload;
    const out = [];
    for (let index = 0; index < payload.turns.length; index += 1) {
        const turn = payload.turns[index];
        if (turn === undefined)
            continue;
        const ordinal = turn.ordinal ?? index;
        const role = turn.role ?? 'unknown';
        const text = turn.text;
        // Source unit id. We don't yet have stable provider message ids
        // in capture events; fall back to URL+role+ordinal+textHash.
        const textHash = sha256(text).slice(0, 16);
        const sourceUnitId = sourceUnitIdFor({
            provider: payload.provider ?? 'unknown',
            ...(payload.threadUrl === undefined ? {} : { canonicalUrl: payload.threadUrl }),
            role,
            turnOrdinal: ordinal,
            sourceSnapshotHash: textHash,
        });
        const content = {
            turns: [
                {
                    ordinal,
                    role,
                    text,
                    ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
                    ...(turn.formattedText === undefined ? {} : { formattedText: turn.formattedText }),
                    ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
                },
            ],
            ...(payload.title === undefined ? {} : { title: payload.title }),
            ...(payload.threadUrl === undefined ? {} : { threadUrl: payload.threadUrl }),
            capturedAt: payload.capturedAt,
        };
        const outputHash = sha256(stableJson(content)).slice(0, 16);
        const inputHash = textHash;
        const extractionRevisionId = `extract_${LEGACY_EXTRACTOR_ID}_v${LEGACY_EXTRACTION_SCHEMA_VERSION}_${outputHash}`;
        out.push({
            extractionRevisionId,
            sourceUnitId,
            sourceBacId: payload.bac_id,
            extractorId: LEGACY_EXTRACTOR_ID,
            extractorVersion: LEGACY_EXTRACTOR_VERSION,
            extractionSchemaVersion: LEGACY_EXTRACTION_SCHEMA_VERSION,
            inputHash,
            outputHash,
            chunkerVersion: LEGACY_CHUNKER_VERSION,
            createdAt: payload.capturedAt,
            producerReplicaId: event.dot.replicaId,
            producerDot: { replicaId: event.dot.replicaId, seq: event.dot.seq },
            content,
        });
    }
    return out;
};
//# sourceMappingURL=legacyExtractor.js.map