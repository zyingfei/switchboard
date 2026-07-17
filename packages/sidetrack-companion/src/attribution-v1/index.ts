// Attribution v1 — public surface (north-star §2). SHADOW ONLY this wave.
export {
  buildAttributionV1State,
  createEmptyAttributionV1State,
  applyOrganizingObservation,
  domainVerdict,
  workstreamLabelCount,
  type AttributionV1State,
  type OrganizingObservation,
} from './state.js';
export {
  scoreVisit,
  shrunkPrecision,
  type AttributionV1Result,
  type AttributionV1Candidate,
  type AttributionV1Action,
} from './scorer.js';
export {
  writeAttributionV1Artifact,
  readAttributionV1Artifact,
  isAttributionV1ArtifactFresh,
  type AttributionV1Artifact,
} from './artifact.js';
export {
  attributionV1ShadowEnabled,
  buildShadowRecord,
  flushShadowBuffer,
  type AttributionV1ShadowRecord,
} from './shadow.js';
export { emitAttributionV1Shadow, incumbentTopFromResolution } from './emit.js';
