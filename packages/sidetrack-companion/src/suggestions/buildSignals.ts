import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { embed } from '../recall/embedder.js';
import { readIndex, type IndexFile } from '../recall/indexFile.js';
import { cosine, meanNormalized } from './centroid.js';
import { containment, jaccard, normalizeTokens } from './tokens.js';
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

type Embedder = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

export const buildSignals = async (
  vaultRoot: string,
  threadId: string,
  workstreams: readonly BuildSignalsWorkstream[],
  indexReader: (path: string) => Promise<IndexFile | null> = readIndex,
  // Override for tests; default uses the production embedder. The
  // function only calls this for workstreams that have no member
  // threads (cold-start), so the cost is bounded by the count of
  // empty workstreams in the vault.
  embedder: Embedder = embed,
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

  // Cold-start vector fallback: a workstream with no member threads
  // has no centroid we can derive from the index, so today's score
  // collapses to lexical+link only — and a glued-together title
  // ("hackernews") has zero word-token overlap with a multi-word
  // thread title ("Hacker News Summary"). We embed the workstream's
  // own {title} {description} text and use that as a synthetic
  // centroid so the vector signal can still rank empty workstreams.
  // Computed in one batched call across every cold workstream.
  const coldStartIds: string[] = [];
  const coldStartTexts: string[] = [];
  for (const workstream of workstreams) {
    const memberCount = threads.filter(
      (candidate) => candidate.primaryWorkstreamId === workstream.id,
    ).length;
    if (memberCount === 0) {
      coldStartIds.push(workstream.id);
      coldStartTexts.push(`${workstream.title} ${workstream.description ?? ''}`.trim());
    }
  }
  const coldStartCentroids = new Map<string, Float32Array>();
  if (coldStartIds.length > 0 && threadCentroid !== null) {
    try {
      const vectors = await embedder(coldStartTexts);
      for (let i = 0; i < coldStartIds.length; i += 1) {
        const id = coldStartIds[i];
        const v = vectors[i];
        if (id !== undefined && v !== undefined) coldStartCentroids.set(id, v);
      }
    } catch {
      // Embedder unavailable (e.g. test fixture without a real
      // embedder) — fall back to vector=0 for cold workstreams,
      // matching the pre-fix behavior. Lexical still applies.
    }
  }

  for (const workstream of workstreams) {
    const wsTokens = normalizeTokens(
      `${workstream.title} ${workstream.description ?? ''}`,
    );
    // Lexical = max(jaccard, ws→thread containment). Jaccard
    // captures bidirectional overlap; the containment term rescues
    // the common case where the workstream name is concentrated
    // ("hackernews") and the thread title carries date/summary
    // noise that drags jaccard down even when the workstream name
    // is fully represented in the thread tokens.
    lexical[workstream.id] = Math.max(
      jaccard(threadTokens, wsTokens),
      containment(wsTokens, threadTokens),
    );
    const memberIds = new Set(
      threads
        .filter((candidate) => candidate.primaryWorkstreamId === workstream.id)
        .map((candidate) => candidate.bac_id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const memberCentroid = meanNormalized(
      index?.items
        .filter((item) => memberIds.has(item.threadId))
        .map((item) => item.embedding) ?? [],
    );
    const workstreamCentroid = memberCentroid ?? coldStartCentroids.get(workstream.id) ?? null;
    vector[workstream.id] =
      threadCentroid === null || workstreamCentroid === null
        ? 0
        : Math.max(0, cosine(threadCentroid, workstreamCentroid));
    link[workstream.id] = thread?.primaryWorkstreamId === workstream.id ? 1 : 0;
  }

  return { lexical, vector, link };
};
