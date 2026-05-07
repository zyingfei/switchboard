// Sync Contract v1 / Class E — extractor manifest + active-revision
// policy.
//
// Each extractor declares its identity (id), semver version, schema
// version, and capability tag set. The active-revision policy picks
// ONE revision per sourceUnitId from the set of available revisions.
// The choice is deterministic across replicas so two browsers with
// different plugin versions converge to the same active revision
// without coordination.
//
// Capability tags are forward-compatible: a future extractor can add
// a tag (e.g. 'image-alt') and existing extractors still compare
// correctly — the new extractor wins on capability score iff its
// tag set is a strict superset.

export type ExtractorCapability =
  | 'code-blocks'
  | 'citations'
  | 'attachments'
  | 'model-name'
  | 'image-alt'
  | 'table-of-contents';

export interface ExtractorManifestEntry {
  readonly extractorId: string;
  readonly extractorVersion: string; // semver
  readonly extractionSchemaVersion: number;
  readonly capabilities: ReadonlySet<ExtractorCapability>;
}

// Currently-shipped extractors. Each provider may have multiple
// extractor implementations over time; manifest entries are added
// here when new ones land.
//
// 'legacy' is the synthetic extractor that wraps existing
// capture.recorded events. It loses to anything that declares a
// non-zero schema version OR a richer capability set OR a higher
// semver.
export const EXTRACTOR_MANIFEST: readonly ExtractorManifestEntry[] = [
  {
    extractorId: 'legacy',
    extractorVersion: '0.0.0',
    extractionSchemaVersion: 1,
    capabilities: new Set<ExtractorCapability>([]),
  },
];

const compareSemver = (a: string, b: string): number => {
  const partsA = a.split('.').map((n) => Number.parseInt(n, 10));
  const partsB = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
};

export interface RevisionCandidate {
  readonly extractionRevisionId: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly extractionSchemaVersion: number;
  readonly tombstoned?: boolean;
  readonly producerDot?: { readonly replicaId: string; readonly seq: number };
}

const capabilityScore = (extractorId: string): number => {
  const entry = EXTRACTOR_MANIFEST.find((e) => e.extractorId === extractorId);
  return entry === undefined ? 0 : entry.capabilities.size;
};

// Picks the active revision deterministically per the documented policy:
//   1. Drop tombstoned.
//   2. Prefer higher extractionSchemaVersion.
//   3. Prefer higher extractor manifest semver.
//   4. If incomparable (different extractorId), prefer richer
//      capability score.
//   5. Tie-break by (replicaId, dot.seq) deterministically.
//
// Returns undefined when the candidate set is empty (or all
// tombstoned). Caller treats that as "this source has no active
// revision yet."
export const selectActiveRevision = (
  candidates: readonly RevisionCandidate[],
): RevisionCandidate | undefined => {
  const live = candidates.filter((c) => c.tombstoned !== true);
  if (live.length === 0) return undefined;
  return live.reduce<RevisionCandidate>((best, candidate) => {
    if (candidate === best) return best;
    // 2. extractionSchemaVersion
    if (candidate.extractionSchemaVersion > best.extractionSchemaVersion) return candidate;
    if (candidate.extractionSchemaVersion < best.extractionSchemaVersion) return best;
    // 3. extractor manifest semver (only meaningful when same extractorId).
    if (candidate.extractorId === best.extractorId) {
      const cmp = compareSemver(candidate.extractorVersion, best.extractorVersion);
      if (cmp > 0) return candidate;
      if (cmp < 0) return best;
    } else {
      // 4. capability score.
      const cs = capabilityScore(candidate.extractorId);
      const bs = capabilityScore(best.extractorId);
      if (cs > bs) return candidate;
      if (cs < bs) return best;
    }
    // 5. deterministic tie-break.
    const cd = candidate.producerDot;
    const bd = best.producerDot;
    if (cd === undefined && bd === undefined) return best;
    if (cd === undefined) return best;
    if (bd === undefined) return candidate;
    if (cd.replicaId !== bd.replicaId) return cd.replicaId < bd.replicaId ? candidate : best;
    return cd.seq < bd.seq ? candidate : best;
  }, live[0]!);
};
