import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import HnswLib from 'hnswlib-node';

const SCHEMA_VERSION = 2;
const INITIAL_MAX_ELEMENTS = 4096;
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 64;
const HNSW_RANDOM_SEED = 100;

export interface UnloadedSimilarityHnswStore {
  ensureLoaded(
    vaultRoot: string,
    identity: number | SimilarityVectorIdentity,
  ): Promise<LoadedSimilarityHnswStore>;
}

export interface SimilarityVectorIdentity {
  readonly dimension: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly vectorCorpusRevision: string;
}

export interface LoadedSimilarityHnswStore {
  elementCount(): number;
  knownLabels(): Promise<ReadonlySet<string>>;
  recoveredFromCorruption(): boolean;
  vectorIdentity?(): SimilarityVectorIdentity;
  insertOrUpdate(visitId: string, embedding: readonly number[]): Promise<void>;
  delete(visitId: string): Promise<void>;
  embedding(visitId: string): Promise<readonly number[] | null>;
  queryTopK(
    visitId: string,
    k: number,
  ): Promise<ReadonlyArray<{ neighborVisitId: string; distance: number }>>;
  persist(): Promise<void>;
  close(): Promise<void>;
}

interface SimilarityHnswSidecar {
  readonly schemaVersion: number;
  readonly dimension: number;
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly vectorCorpusRevision?: string;
  readonly elementCount: number;
  readonly visitIdToLabel: Record<string, number>;
  readonly labelToVisitId: Record<string, string>;
}

interface LoadedState {
  readonly vaultRoot: string;
  readonly basePath: string;
  readonly pointerPath: string;
  readonly index: HnswLib.HierarchicalNSW;
  dimension: number;
  readonly vectorIdentity: SimilarityVectorIdentity;
  maxElements: number;
  /**
   * High-water mark of the label allocator, persisted as the sidecar's
   * `elementCount`. This is NOT the live element count — `visitIdToLabel.size`
   * is. Conflating the two is what let the slot leak below go unnoticed.
   */
  labelWatermark: number;
  /**
   * Labels whose hnswlib slot exists in the index but that no live visit maps
   * to. Re-adding one of these labels reuses its slot in place, so the
   * allocator hands them back out before it grows the watermark.
   */
  readonly freeLabels: number[];
  version: number;
  readonly visitIdToLabel: Map<string, number>;
  readonly labelToVisitId: Map<number, string>;
  readonly recoveredFromCorruption: boolean;
  /** Set by every mutation; cleared by persist(). See persist() for why. */
  dirty: boolean;
}

interface SimilarityHnswStoreOptions {
  readonly renameFile?: typeof rename;
}

const basePathFor = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw');

const pointerPathFor = (vaultRoot: string): string => `${basePathFor(vaultRoot)}.current`;

const indexPathFor = (vaultRoot: string): string => `${basePathFor(vaultRoot)}.bin`;

const sidecarPathFor = (vaultRoot: string): string => `${basePathFor(vaultRoot)}.json`;

const versionedIndexPath = (basePath: string, version: number): string =>
  `${basePath}.v${String(version)}.bin`;

const versionedSidecarPath = (basePath: string, version: number): string =>
  `${basePath}.v${String(version)}.json`;

const parsePointer = (raw: string): number => {
  const trimmed = raw.trim();
  const match = /^v(\d+)$/u.exec(trimmed);
  if (match === null) throw new Error(`invalid HNSW pointer: ${trimmed}`);
  return Number(match[1]);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const parseSidecar = (raw: string): SimilarityHnswSidecar => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid HNSW sidecar: expected object');
  }
  const value = parsed as Record<string, unknown>;
  const schemaVersion = value['schemaVersion'];
  const dimension = value['dimension'];
  const elementCount = value['elementCount'];
  const visitIdToLabel = value['visitIdToLabel'];
  const labelToVisitId = value['labelToVisitId'];
  const modelId = value['modelId'];
  const modelRevision = value['modelRevision'];
  const vectorCorpusRevision = value['vectorCorpusRevision'];
  if (schemaVersion !== 1 && schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported HNSW sidecar schemaVersion: ${String(schemaVersion)}`);
  }
  if (
    typeof dimension !== 'number' ||
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    typeof elementCount !== 'number' ||
    !Number.isInteger(elementCount) ||
    elementCount < 0 ||
    typeof visitIdToLabel !== 'object' ||
    visitIdToLabel === null ||
    Array.isArray(visitIdToLabel) ||
    typeof labelToVisitId !== 'object' ||
    labelToVisitId === null ||
    Array.isArray(labelToVisitId)
  ) {
    throw new Error('invalid HNSW sidecar shape');
  }
  if (
    schemaVersion === SCHEMA_VERSION &&
    (typeof modelId !== 'string' ||
      modelId.length === 0 ||
      typeof modelRevision !== 'string' ||
      modelRevision.length === 0 ||
      typeof vectorCorpusRevision !== 'string' ||
      vectorCorpusRevision.length === 0)
  ) {
    throw new Error('invalid HNSW sidecar vector identity');
  }
  const visitLabels = visitIdToLabel as Record<string, unknown>;
  const labelVisits = labelToVisitId as Record<string, unknown>;
  for (const [visitId, label] of Object.entries(visitLabels)) {
    if (
      visitId.length === 0 ||
      typeof label !== 'number' ||
      !Number.isInteger(label) ||
      label < 0
    ) {
      throw new Error('invalid HNSW sidecar visitIdToLabel entry');
    }
  }
  for (const [label, visitId] of Object.entries(labelVisits)) {
    if (
      !/^\d+$/u.test(label) ||
      typeof visitId !== 'string' ||
      visitId.length === 0 ||
      visitLabels[visitId] !== Number(label)
    ) {
      throw new Error('invalid HNSW sidecar labelToVisitId entry');
    }
  }
  return {
    schemaVersion,
    dimension,
    ...(typeof modelId === 'string' ? { modelId } : {}),
    ...(typeof modelRevision === 'string' ? { modelRevision } : {}),
    ...(typeof vectorCorpusRevision === 'string' ? { vectorCorpusRevision } : {}),
    elementCount,
    visitIdToLabel: visitLabels as Record<string, number>,
    labelToVisitId: labelVisits as Record<string, string>,
  };
};

const sidecarFor = (state: LoadedState): SimilarityHnswSidecar => ({
  schemaVersion: SCHEMA_VERSION,
  dimension: state.dimension,
  modelId: state.vectorIdentity.modelId,
  modelRevision: state.vectorIdentity.modelRevision,
  vectorCorpusRevision: state.vectorIdentity.vectorCorpusRevision,
  elementCount: state.labelWatermark,
  visitIdToLabel: Object.fromEntries(
    [...state.visitIdToLabel.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ),
  labelToVisitId: Object.fromEntries(
    [...state.labelToVisitId.entries()]
      .sort(([a], [b]) => a - b)
      .map(([label, visitId]) => [String(label), visitId]),
  ),
});

const gcOldVersions = async (basePath: string, keepVersion: number): Promise<void> => {
  const dir = dirname(basePath);
  const prefix = `${basePath.slice(dir.length + 1)}.v`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => {
        if (!entry.startsWith(prefix)) return false;
        return !entry.startsWith(`${prefix}${String(keepVersion)}.`);
      })
      .map(async (entry) => {
        try {
          await unlink(join(dir, entry));
        } catch {
          // Best-effort cleanup; pointer publication is already complete.
        }
      }),
  );
};

/**
 * Slots that physically exist in the loaded index but that no live visit maps
 * to. hnswlib keeps a markDeleted element's slot allocated forever and sizes
 * its file by `cur_element_count`, so these are the leaked bytes: on the
 * dogfood vault the index had allocated 29,814 slots to hold 737 live visits
 * (40.4x), and the .bin was 50,138,820 bytes where the live vectors need
 * ~1.24 MB (99.7% of the file is `cur_element_count * 1676`).
 *
 * Recovering them costs nothing and changes nothing that is served: re-adding
 * a label hnswlib already knows updates that element in place, leaving every
 * other stored vector bit-identical (measured: 0 perturbed float components
 * across 400x384 untouched vectors).
 */
const reusableLabelsFor = (slotCount: number, liveLabels: Iterable<number>): number[] => {
  const live = new Set(liveLabels);
  const free: number[] = [];
  // Descending push so that pop() hands out the LOWEST free label first,
  // which keeps allocation deterministic across runs.
  for (let label = slotCount - 1; label >= 0; label -= 1) {
    if (!live.has(label)) free.push(label);
  }
  return free;
};

const assertEmbedding = (embedding: readonly number[], dimension: number): void => {
  if (embedding.length !== dimension) {
    throw new Error(
      `invalid HNSW embedding dimension: expected ${String(dimension)}, received ${String(embedding.length)}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) throw new Error('invalid HNSW embedding: non-finite value');
  }
};

const testVectorIdentity = (dimension: number): SimilarityVectorIdentity => ({
  dimension,
  modelId: 'test-model',
  modelRevision: 'test-revision',
  vectorCorpusRevision: 'test-corpus-revision',
});

const assertSameVectorIdentity = (
  sidecar: SimilarityHnswSidecar,
  requested: SimilarityVectorIdentity,
): void => {
  if (sidecar.dimension !== requested.dimension) {
    throw new Error(
      `HNSW dimension mismatch: sidecar=${String(sidecar.dimension)} requested=${String(requested.dimension)}`,
    );
  }
  // Schema v1 is the migration source. It had no identity and is accepted
  // once under the frozen legacy policy; the next persist publishes v2.
  if (sidecar.schemaVersion === 1) return;
  if (
    sidecar.modelId !== requested.modelId ||
    sidecar.modelRevision !== requested.modelRevision ||
    sidecar.vectorCorpusRevision !== requested.vectorCorpusRevision
  ) {
    throw new Error(
      `HNSW vector identity mismatch: sidecar=${String(sidecar.vectorCorpusRevision)} requested=${requested.vectorCorpusRevision}`,
    );
  }
};

export const createSimilarityHnswStore = (
  options: SimilarityHnswStoreOptions = {},
): UnloadedSimilarityHnswStore => {
  const renameFile = options.renameFile ?? rename;
  let state: LoadedState | null = null;

  const requireLoaded = (): LoadedState => {
    if (state === null) throw new Error('HNSW similarity store is not loaded');
    return state;
  };

  const loadedStore: LoadedSimilarityHnswStore = {
    elementCount(): number {
      return requireLoaded().visitIdToLabel.size;
    },

    async knownLabels(): Promise<ReadonlySet<string>> {
      return new Set(requireLoaded().visitIdToLabel.keys());
    },

    recoveredFromCorruption(): boolean {
      return requireLoaded().recoveredFromCorruption;
    },

    vectorIdentity(): SimilarityVectorIdentity {
      return { ...requireLoaded().vectorIdentity };
    },

    async insertOrUpdate(visitId: string, embedding: readonly number[]): Promise<void> {
      const loaded = requireLoaded();
      if (visitId.length === 0) throw new Error('invalid HNSW visitId: empty');
      assertEmbedding(embedding, loaded.dimension);
      const existingLabel = loaded.visitIdToLabel.get(visitId);
      if (existingLabel !== undefined) {
        // Update in place. The previous shape markDeleted this label and then
        // burned a fresh one, so every re-embed of an already-known visit
        // permanently leaked a slot; hnswlib updates a known label without
        // growing `cur_element_count`, and the mapping is already correct.
        loaded.index.addPoint(Array.from(embedding), existingLabel);
        loaded.dirty = true;
        return;
      }
      const reusedLabel = loaded.freeLabels.pop();
      let label: number;
      if (reusedLabel === undefined) {
        if (loaded.labelWatermark >= loaded.maxElements) {
          const nextMaxElements = Math.max(1, loaded.maxElements * 2);
          loaded.index.resizeIndex(nextMaxElements);
          loaded.maxElements = nextMaxElements;
        }
        label = loaded.labelWatermark;
        loaded.labelWatermark += 1;
      } else {
        // The slot already exists in the index, so no capacity check is
        // needed — re-adding a known label reuses it rather than appending.
        label = reusedLabel;
      }
      loaded.index.addPoint(Array.from(embedding), label);
      loaded.visitIdToLabel.set(visitId, label);
      loaded.labelToVisitId.set(label, visitId);
      loaded.dirty = true;
    },

    async delete(visitId: string): Promise<void> {
      const loaded = requireLoaded();
      const label = loaded.visitIdToLabel.get(visitId);
      if (label === undefined) return;
      loaded.index.markDelete(label);
      loaded.visitIdToLabel.delete(visitId);
      loaded.labelToVisitId.delete(label);
      // Hand the slot back to the allocator instead of stranding it.
      loaded.freeLabels.push(label);
      loaded.dirty = true;
    },

    async embedding(visitId: string): Promise<readonly number[] | null> {
      const loaded = requireLoaded();
      const label = loaded.visitIdToLabel.get(visitId);
      if (label === undefined) return null;
      return Array.from(loaded.index.getPoint(label));
    },

    async queryTopK(
      visitId: string,
      k: number,
    ): Promise<ReadonlyArray<{ neighborVisitId: string; distance: number }>> {
      const loaded = requireLoaded();
      if (!Number.isInteger(k) || k < 0) throw new Error(`invalid HNSW k: ${String(k)}`);
      if (k === 0) return [];
      const label = loaded.visitIdToLabel.get(visitId);
      if (label === undefined) return [];
      const embedding = loaded.index.getPoint(label);
      const result = loaded.index.searchKnn(
        Array.from(embedding),
        Math.min(k + 1, loaded.visitIdToLabel.size),
      );
      const rows: { neighborVisitId: string; distance: number }[] = [];
      for (let i = 0; i < result.neighbors.length; i += 1) {
        const neighborLabel = result.neighbors[i];
        if (neighborLabel === undefined || neighborLabel === label) continue;
        const neighborVisitId = loaded.labelToVisitId.get(neighborLabel);
        const distance = result.distances[i];
        if (neighborVisitId === undefined || distance === undefined) continue;
        rows.push({ neighborVisitId, distance });
        if (rows.length >= k) break;
      }
      return rows;
    },

    async persist(): Promise<void> {
      const loaded = requireLoaded();
      // The materializer persists once per drain, unconditionally — including
      // on drains that carry the previous revision's edges forward without
      // touching a single vector. Republishing then rewrites the whole index
      // (50 MB on the dogfood vault) to produce a byte-identical successor.
      // Nothing observable depends on the version advancing, so skip it.
      if (!loaded.dirty) return;
      await mkdir(dirname(loaded.basePath), { recursive: true });
      const nextVersion = loaded.version + 1;
      const nextIndexPath = versionedIndexPath(loaded.basePath, nextVersion);
      const nextSidecarPath = versionedSidecarPath(loaded.basePath, nextVersion);
      const indexTmpPath = `${nextIndexPath}.tmp`;
      const sidecarTmpPath = `${nextSidecarPath}.tmp`;
      const pointerTmpPath = `${loaded.pointerPath}.tmp`;
      await loaded.index.writeIndex(indexTmpPath);
      await writeFile(sidecarTmpPath, `${JSON.stringify(sidecarFor(loaded), null, 2)}\n`, 'utf8');
      await renameFile(indexTmpPath, nextIndexPath);
      await renameFile(sidecarTmpPath, nextSidecarPath);
      await writeFile(pointerTmpPath, `v${String(nextVersion)}\n`, 'utf8');
      await renameFile(pointerTmpPath, loaded.pointerPath);
      loaded.version = nextVersion;
      loaded.dirty = false;
      await gcOldVersions(loaded.basePath, nextVersion);
    },

    async close(): Promise<void> {
      state = null;
    },
  };

  return {
    async ensureLoaded(
      vaultRoot: string,
      identity: number | SimilarityVectorIdentity,
    ): Promise<LoadedSimilarityHnswStore> {
      const vectorIdentity =
        typeof identity === 'number' ? testVectorIdentity(identity) : { ...identity };
      const dimension = vectorIdentity.dimension;
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new Error(`invalid HNSW dimension: ${String(dimension)}`);
      }
      if (state !== null) {
        if (
          state.vaultRoot !== vaultRoot ||
          state.dimension !== dimension ||
          state.vectorIdentity.vectorCorpusRevision !== vectorIdentity.vectorCorpusRevision
        ) {
          throw new Error(
            'HNSW similarity store already loaded for a different vault or dimension',
          );
        }
        return loadedStore;
      }

      const basePath = basePathFor(vaultRoot);
      const pointerPath = pointerPathFor(vaultRoot);
      await mkdir(dirname(basePath), { recursive: true });
      const index = new HnswLib.HierarchicalNSW('cosine', dimension);
      const hasPointer = await pathExists(pointerPath);
      let recoveredFromCorruption = false;
      if (hasPointer) {
        try {
          const version = parsePointer(await readFile(pointerPath, 'utf8'));
          const sidecar = parseSidecar(
            await readFile(versionedSidecarPath(basePath, version), 'utf8'),
          );
          assertSameVectorIdentity(sidecar, vectorIdentity);
          await index.readIndex(versionedIndexPath(basePath, version));
          index.setEf(HNSW_EF_SEARCH);
          const visitIdToLabel = new Map(Object.entries(sidecar.visitIdToLabel));
          state = {
            vaultRoot,
            basePath,
            pointerPath,
            index,
            dimension,
            vectorIdentity,
            maxElements: index.getMaxElements(),
            labelWatermark: sidecar.elementCount,
            freeLabels: reusableLabelsFor(index.getCurrentCount(), visitIdToLabel.values()),
            version,
            visitIdToLabel,
            labelToVisitId: new Map(
              Object.entries(sidecar.labelToVisitId).map(([label, visitId]) => [
                Number(label),
                visitId,
              ]),
            ),
            recoveredFromCorruption: false,
            // Clean read of the published pair — nothing to republish unless a
            // mutation lands, except when the sidecar is still on the legacy
            // schema and the next persist owes it an upgrade.
            dirty: sidecar.schemaVersion !== SCHEMA_VERSION,
          };
          return loadedStore;
        } catch {
          // A crash can leave the pointer or one half of a versioned pair
          // missing. Treat that as an empty store; the reconcile pass
          // rebuilds from the event log and publishes a fresh pair.
          recoveredFromCorruption = true;
        }
      }
      const legacyIndexPath = indexPathFor(vaultRoot);
      const legacySidecarPath = sidecarPathFor(vaultRoot);
      const hasIndex = await pathExists(legacyIndexPath);
      const hasSidecar = await pathExists(legacySidecarPath);
      if (hasIndex && hasSidecar) {
        const sidecar = parseSidecar(await readFile(legacySidecarPath, 'utf8'));
        assertSameVectorIdentity(sidecar, vectorIdentity);
        await index.readIndex(legacyIndexPath);
        index.setEf(HNSW_EF_SEARCH);
        const visitIdToLabel = new Map(Object.entries(sidecar.visitIdToLabel));
        state = {
          vaultRoot,
          basePath,
          pointerPath,
          index,
          dimension,
          vectorIdentity,
          maxElements: index.getMaxElements(),
          labelWatermark: sidecar.elementCount,
          freeLabels: reusableLabelsFor(index.getCurrentCount(), visitIdToLabel.values()),
          version: 0,
          visitIdToLabel,
          labelToVisitId: new Map(
            Object.entries(sidecar.labelToVisitId).map(([label, visitId]) => [
              Number(label),
              visitId,
            ]),
          ),
          recoveredFromCorruption: false,
          // Unversioned legacy pair: the next persist owes it a versioned one.
          dirty: true,
        };
        return loadedStore;
      }

      index.initIndex(INITIAL_MAX_ELEMENTS, HNSW_M, HNSW_EF_CONSTRUCTION, HNSW_RANDOM_SEED);
      index.setEf(HNSW_EF_SEARCH);
      state = {
        vaultRoot,
        basePath,
        pointerPath,
        index,
        dimension,
        vectorIdentity,
        maxElements: INITIAL_MAX_ELEMENTS,
        labelWatermark: 0,
        freeLabels: [],
        version: 0,
        visitIdToLabel: new Map(),
        labelToVisitId: new Map(),
        recoveredFromCorruption,
        // Fresh (or recovered) index: publish an initial pair on first persist.
        dirty: true,
      };
      return loadedStore;
    },
  };
};
