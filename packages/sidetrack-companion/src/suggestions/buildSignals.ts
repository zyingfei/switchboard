import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readIndex, type IndexFile } from '../recall/indexFile.js';
import { cosine, meanNormalized } from './centroid.js';
import { jaccard, normalizeTokens } from './tokens.js';
import type { SignalSet } from './score.js';

export interface BuildSignalsWorkstream {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

interface ThreadRecord {
  readonly bac_id?: string;
  readonly title?: string;
  readonly primaryWorkstreamId?: string;
}

const readJson = async <TValue>(path: string): Promise<TValue | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as TValue;
  } catch {
    return null;
  }
};

const readThreads = async (vaultRoot: string): Promise<readonly ThreadRecord[]> => {
  const root = join(vaultRoot, '_BAC', 'threads');
  const names = await readdir(root).catch(() => []);
  const threads = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<ThreadRecord>(join(root, name))),
  );
  return threads.filter((thread): thread is ThreadRecord => thread !== null);
};

export const buildSignals = async (
  vaultRoot: string,
  threadId: string,
  workstreams: readonly BuildSignalsWorkstream[],
  indexReader: (path: string) => Promise<IndexFile | null> = readIndex,
): Promise<SignalSet> => {
  const threads = await readThreads(vaultRoot);
  const thread = threads.find((candidate) => candidate.bac_id === threadId);
  const index = await indexReader(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
  const threadVectors = index?.items
    .filter((item) => item.threadId === threadId)
    .map((item) => item.embedding);
  const threadCentroid = meanNormalized(threadVectors ?? []);

  const lexical: Record<string, number> = {};
  const vector: Record<string, number> = {};
  const link: Record<string, number> = {};
  const threadTokens = normalizeTokens(thread?.title ?? threadId);

  for (const workstream of workstreams) {
    lexical[workstream.id] = jaccard(
      threadTokens,
      normalizeTokens(`${workstream.title} ${workstream.description ?? ''}`),
    );
    const memberIds = new Set(
      threads
        .filter((candidate) => candidate.primaryWorkstreamId === workstream.id)
        .map((candidate) => candidate.bac_id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const workstreamCentroid = meanNormalized(
      index?.items
        .filter((item) => memberIds.has(item.threadId))
        .map((item) => item.embedding) ?? [],
    );
    vector[workstream.id] =
      threadCentroid === null || workstreamCentroid === null
        ? 0
        : Math.max(0, cosine(threadCentroid, workstreamCentroid));
    link[workstream.id] = thread?.primaryWorkstreamId === workstream.id ? 1 : 0;
  }

  return { lexical, vector, link };
};
