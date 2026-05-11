import type { AcceptedEvent } from '../../sync/causal.js';
import { type ExtractionRevision } from './types.js';
export declare const LEGACY_EXTRACTOR_ID = "legacy";
export declare const LEGACY_EXTRACTOR_VERSION = "0.0.0";
export declare const LEGACY_EXTRACTION_SCHEMA_VERSION = 1;
export declare const LEGACY_CHUNKER_VERSION = "legacy";
export declare const wrapCaptureAsLegacyRevisions: (event: AcceptedEvent) => readonly ExtractionRevision[];
//# sourceMappingURL=legacyExtractor.d.ts.map