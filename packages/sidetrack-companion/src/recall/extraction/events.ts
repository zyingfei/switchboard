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

export const CAPTURE_EXTRACTION_PRODUCED = 'capture.extraction.produced' as const;

export type ExtractionEventType = typeof CAPTURE_EXTRACTION_PRODUCED;

export interface CaptureExtractionProducedPayload {
  readonly sourceUnitId: string;
  readonly sourceBacId: string;
  readonly extractionRevisionId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly extractionSchemaVersion: number;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly chunkerVersion: string;
  // Carried inline so peers can consume the revision without an
  // extra HTTP fetch. The companion's extraction store keeps the
  // revision file durably; the event is the wire-format.
  readonly content: {
    readonly turns: readonly {
      readonly ordinal: number;
      readonly role: 'user' | 'assistant' | 'system' | 'unknown';
      readonly text: string;
      readonly markdown?: string;
      readonly formattedText?: string;
      readonly modelName?: string;
    }[];
    readonly title?: string;
    readonly threadUrl?: string;
    readonly capturedAt: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isCaptureExtractionProducedPayload = (
  value: unknown,
): value is CaptureExtractionProducedPayload => {
  if (!isRecord(value)) return false;
  if (typeof value['sourceUnitId'] !== 'string') return false;
  if (typeof value['extractionRevisionId'] !== 'string') return false;
  if (typeof value['extractorId'] !== 'string') return false;
  if (typeof value['extractorVersion'] !== 'string') return false;
  if (typeof value['extractionSchemaVersion'] !== 'number') return false;
  return isRecord(value['content']);
};
