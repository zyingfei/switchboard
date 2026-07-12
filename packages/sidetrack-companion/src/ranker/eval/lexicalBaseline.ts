// Wave 0 — freeze-safe eval spine (report-only).
//
// External-baseline scorers for the replay harness. These are the
// NON-NEGOTIABLE honest floors from the recsys data-architecture review:
// agent-memory research repeatedly shows filesystem + grep beats fancy
// retrieval, so a learned re-ranker that cannot beat a lexical BM25 floor
// (or a recency-only "just give the agent everything newest-first" floor)
// has not earned its complexity.
//
// NOTHING here influences serving. It scores the SAME served impressions
// the model + graph baseline are scored on, so the harness can print every
// arm side by side. All pure functions + a thin vault-content reader.

import { readPageEvidenceMap } from '../../page-evidence/store.js';
import type { PageEvidenceRecord } from '../../page-evidence/types.js';

/**
 * The per-candidate document the lexical + recency floors score over. The
 * served impression snapshot carries entityId / canonicalUrl but no title
 * or body text (those would bloat the log), so the harness reads the
 * point-in-time-ish vault content by canonical URL. A candidate with no
 * vault content becomes an EMPTY document (zero lexical score, no recency
 * timestamp) — that is the honest floor: grep can only score what is on
 * disk.
 */
export interface CandidateDocument {
  readonly entityId: string;
  /** Lowercased tokens from title + content terms + URL path. */
  readonly tokens: readonly string[];
  /** ms epoch of the freshest evidence timestamp, or undefined when absent. */
  readonly updatedAtMs?: number;
}

const TOKEN_SPLIT = /[^a-z0-9]+/u;

/** Lowercase + split on non-alphanumerics; drop empties + 1-char noise. */
export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 1);

const pathTokensFromUrl = (url: string | undefined): string[] => {
  if (url === undefined) return [];
  try {
    const parsed = new URL(url);
    return tokenize(`${parsed.hostname} ${parsed.pathname}`);
  } catch {
    return tokenize(url);
  }
};

const parseMs = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Build the lexical document for one candidate from its evidence record.
 *  Title tokens + content-term tokens + URL-path tokens are unioned into a
 *  bag; the recency timestamp is the freshest of updatedAt / lastSeenAt. */
export const documentFromEvidence = (
  entityId: string,
  canonicalUrl: string | undefined,
  record: PageEvidenceRecord | undefined,
): CandidateDocument => {
  const tokens: string[] = [];
  if (record?.metadata.title !== undefined) tokens.push(...tokenize(record.metadata.title));
  for (const token of record?.metadata.titleTokens ?? []) tokens.push(...tokenize(token));
  for (const term of record?.content?.terms ?? []) tokens.push(...tokenize(term.term));
  for (const phrase of record?.content?.keyphrases ?? []) tokens.push(...tokenize(phrase.term));
  tokens.push(...pathTokensFromUrl(canonicalUrl ?? record?.canonicalUrl));
  const updatedAtMs = parseMs(record?.metadata.lastSeenAt) ?? parseMs(record?.updatedAt);
  return {
    entityId,
    tokens,
    ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
  };
};

export interface CandidateRef {
  readonly entityId: string;
  readonly canonicalUrl?: string;
}

/**
 * Read the vault-content documents for a set of candidates by canonical
 * URL. Read-only over `_BAC/page-evidence`; runs WITHOUT the companion.
 * Candidates with no evidence become empty documents (the honest floor).
 */
export const readCandidateDocuments = async (
  vaultRoot: string,
  candidates: readonly CandidateRef[],
): Promise<ReadonlyMap<string, CandidateDocument>> => {
  const urls = candidates
    .map((candidate) => candidate.canonicalUrl)
    .filter((url): url is string => url !== undefined);
  const evidenceByUrl = await readPageEvidenceMap(vaultRoot, [...new Set(urls)]);
  const out = new Map<string, CandidateDocument>();
  for (const candidate of candidates) {
    const record =
      candidate.canonicalUrl === undefined ? undefined : evidenceByUrl.get(candidate.canonicalUrl);
    out.set(
      candidate.entityId,
      documentFromEvidence(candidate.entityId, candidate.canonicalUrl, record),
    );
  }
  return out;
};

/**
 * BM25 scores for one query over a small candidate set. IDF + document
 * length are computed OVER THE CANDIDATE SET of a single impression (the
 * grep-over-vault floor operates per query, not over a global corpus) —
 * this keeps the floor honest and self-contained: a term that appears in
 * every candidate carries no discriminative weight, exactly as a lexical
 * matcher over the shown set would behave.
 *
 * k1 / b are the standard BM25 constants. Returns a score per entityId in
 * the input order; entityIds not present in `documents` score 0.
 */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

export const bm25Scores = (
  queryTokens: readonly string[],
  candidateEntityIds: readonly string[],
  documents: ReadonlyMap<string, CandidateDocument>,
): ReadonlyMap<string, number> => {
  const docs = candidateEntityIds.map(
    (entityId) => documents.get(entityId) ?? { entityId, tokens: [] as readonly string[] },
  );
  const n = docs.length;
  const avgdl = n === 0 ? 0 : docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / n;
  // Document frequency per query term across the candidate set.
  const df = new Map<string, number>();
  const termFreqs = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return tf;
  });
  const queryTermSet = new Set(queryTokens);
  for (const term of queryTermSet) {
    let count = 0;
    for (const tf of termFreqs) if (tf.has(term)) count += 1;
    df.set(term, count);
  }
  const scores = new Map<string, number>();
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]!;
    const tf = termFreqs[index]!;
    const dl = doc.tokens.length;
    let score = 0;
    for (const term of queryTermSet) {
      const termFreq = tf.get(term) ?? 0;
      if (termFreq === 0) continue;
      const documentFrequency = df.get(term) ?? 0;
      // BM25+ IDF with the `+1` inside the log, floored at 0. The `+1`
      // smoothing keeps IDF strictly positive even on the SMALL
      // per-impression candidate sets this floor runs over (the classic
      // ln((n-df+0.5)/(df+0.5)) form collapses to 0 or goes negative once
      // df ≥ n/2, which at n=2/3 zeroes out almost every term). A term
      // present in EVERY candidate still gets EQUAL weight across them, so
      // it cannot change the RANKING — which is all nDCG/MRR care about.
      const idf = Math.max(
        0,
        Math.log((n - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1),
      );
      const denom = termFreq + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (avgdl === 0 ? 1 : avgdl));
      score += idf * ((termFreq * (BM25_K1 + 1)) / (denom === 0 ? 1 : denom));
    }
    scores.set(doc.entityId, score);
  }
  return scores;
};

/**
 * Recency scores — the "full-context / just give the agent everything
 * newest-first" floor. Higher score = fresher. Candidates with no evidence
 * timestamp fall to the BOTTOM (score −∞ modelled as a large negative), so
 * an undated candidate never outranks a dated one; ties break on the
 * candidate order the caller supplies (already deterministic).
 */
export const recencyScores = (
  candidateEntityIds: readonly string[],
  documents: ReadonlyMap<string, CandidateDocument>,
): ReadonlyMap<string, number> => {
  const scores = new Map<string, number>();
  for (const entityId of candidateEntityIds) {
    const updatedAtMs = documents.get(entityId)?.updatedAtMs;
    scores.set(entityId, updatedAtMs ?? Number.NEGATIVE_INFINITY);
  }
  return scores;
};
