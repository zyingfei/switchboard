// Sync Contract v1 / Class E — capture.extraction.produced event.
//
// Emitted by a replica that has produced a fresher extraction
// revision for an existing sourceUnitId. Peers consume via the
// runner → extraction materializer; the materializer writes the
// revision to the store and runs active-revision policy. If the new
// revision becomes active, the recall materializer's catchUp scans
// the source state and source-replaces its index entries (no full
// rebuild).
//
// This is the load-bearing event for the no-login peer case:
// browser B re-visits chatgpt under v1.1, emits this event; browser
// A consumes it without ever loading chatgpt.com and updates its
// recall index.
export const CAPTURE_EXTRACTION_PRODUCED = 'capture.extraction.produced';
const isRecord = (value) => typeof value === 'object' && value !== null;
export const isCaptureExtractionProducedPayload = (value) => {
    if (!isRecord(value))
        return false;
    if (typeof value['sourceUnitId'] !== 'string')
        return false;
    if (typeof value['extractionRevisionId'] !== 'string')
        return false;
    if (typeof value['extractorId'] !== 'string')
        return false;
    if (typeof value['extractorVersion'] !== 'string')
        return false;
    if (typeof value['extractionSchemaVersion'] !== 'number')
        return false;
    return isRecord(value['content']);
};
//# sourceMappingURL=events.js.map