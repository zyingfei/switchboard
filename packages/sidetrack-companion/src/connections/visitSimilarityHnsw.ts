import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import HnswLib from 'hnswlib-node';

const SCHEMA_VERSION = 1;
const INITIAL_MAX_ELEMENTS = 4096;
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 64;
const HNSW_RANDOM_SEED = 100;

export interface UnloadedSimilarityHnswStore {
  ensureLoaded(vaultRoot: string, dimension: number): Promise<LoadedSimilarityHnswStore>;
}

export interface LoadedSimilarityHnswStore {
  elementCount(): number;
  knownLabels(): Promise<ReadonlySet<string>>;
  recoveredFromCorruption(): boolean;
  insertOrUpdate(visitId: string, embedding: readonly number[]): Promise<void>;
  delete(visitId: string): Promise<void>;
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
  maxElements: number;
  elementCount: number;
  version: number;
  readonly visitIdToLabel: Map<string, number>;
  readonly labelToVisitId: Map<number, string>;
  readonly recoveredFromCorruption: boolean;
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
  if (schemaVersion !== SCHEMA_VERSION) {
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
  const visitLabels = visitIdToLabel as Record<string, unknown>;
  const labelVisits = labelToVisitId as Record<string, unknown>;
  for (const [visitId, label] of Object.entries(visitLabels)) {
    if (visitId.length === 0 || typeof label !== 'number' || !Number.isInteger(label) || label < 0) {
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
    elementCount,
    visitIdToLabel: visitLabels as Record<string, number>,
    labelToVisitId: labelVisits as Record<string, string>,
  };
};

const sidecarFor = (state: LoadedState): SimilarityHnswSidecar => ({
  schemaVersion: SCHEMA_VERSION,
  dimension: state.dimension,
  elementCount: state.elementCount,
  visitIdToLabel: Object.fromEntries([...state.visitIdToLabel.entries()].sort(([a], [b]) => a.localeCompare(b))),
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

    async insertOrUpdate(visitId: string, embedding: readonly number[]): Promise<void> {
      const loaded = requireLoaded();
      if (visitId.length === 0) throw new Error('invalid HNSW visitId: empty');
      assertEmbedding(embedding, loaded.dimension);
      const existingLabel = loaded.visitIdToLabel.get(visitId);
      if (existingLabel !== undefined) {
        loaded.index.markDelete(existingLabel);
        loaded.visitIdToLabel.delete(visitId);
        loaded.labelToVisitId.delete(existingLabel);
      }
      if (loaded.elementCount >= loaded.maxElements) {
        const nextMaxElements = Math.max(1, loaded.maxElements * 2);
        loaded.index.resizeIndex(nextMaxElements);
        loaded.maxElements = nextMaxElements;
      }
      const label = loaded.elementCount;
      loaded.elementCount += 1;
      loaded.index.addPoint(Array.from(embedding), label);
      loaded.visitIdToLabel.set(visitId, label);
      loaded.labelToVisitId.set(label, visitId);
    },

    async delete(visitId: string): Promise<void> {
      const loaded = requireLoaded();
      const label = loaded.visitIdToLabel.get(visitId);
      if (label === undefined) return;
      loaded.index.markDelete(label);
      loaded.visitIdToLabel.delete(visitId);
      loaded.labelToVisitId.delete(label);
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
      await gcOldVersions(loaded.basePath, nextVersion);
    },

    async close(): Promise<void> {
      state = null;
    },
  };

  return {
    async ensureLoaded(
      vaultRoot: string,
      dimension: number,
    ): Promise<LoadedSimilarityHnswStore> {
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new Error(`invalid HNSW dimension: ${String(dimension)}`);
      }
      if (state !== null) {
        if (state.vaultRoot !== vaultRoot || state.dimension !== dimension) {
          throw new Error('HNSW similarity store already loaded for a different vault or dimension');
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
          if (sidecar.dimension !== dimension) {
            throw new Error(
              `HNSW dimension mismatch: sidecar=${String(sidecar.dimension)} requested=${String(dimension)}`,
            );
          }
          await index.readIndex(versionedIndexPath(basePath, version));
          index.setEf(HNSW_EF_SEARCH);
          state = {
            vaultRoot,
            basePath,
            pointerPath,
            index,
            dimension,
            maxElements: index.getMaxElements(),
            elementCount: sidecar.elementCount,
            version,
            visitIdToLabel: new Map(Object.entries(sidecar.visitIdToLabel)),
            labelToVisitId: new Map(
              Object.entries(sidecar.labelToVisitId).map(([label, visitId]) => [
                Number(label),
                visitId,
              ]),
            ),
            recoveredFromCorruption: false,
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
        if (sidecar.dimension !== dimension) {
          throw new Error(
            `HNSW dimension mismatch: sidecar=${String(sidecar.dimension)} requested=${String(dimension)}`,
          );
        }
        await index.readIndex(legacyIndexPath);
        index.setEf(HNSW_EF_SEARCH);
        state = {
          vaultRoot,
          basePath,
          pointerPath,
          index,
          dimension,
          maxElements: index.getMaxElements(),
          elementCount: sidecar.elementCount,
          version: 0,
          visitIdToLabel: new Map(Object.entries(sidecar.visitIdToLabel)),
          labelToVisitId: new Map(
            Object.entries(sidecar.labelToVisitId).map(([label, visitId]) => [Number(label), visitId]),
          ),
          recoveredFromCorruption: false,
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
        maxElements: INITIAL_MAX_ELEMENTS,
        elementCount: 0,
        version: 0,
        visitIdToLabel: new Map(),
        labelToVisitId: new Map(),
        recoveredFromCorruption,
      };
      return loadedStore;
    },
  };
};
