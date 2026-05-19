import { createHash } from 'node:crypto';

import { blendedIdf } from './idf.js';
import type {
  PageEvidenceMetadataInput,
  PageEvidenceRecord,
  VectorRef,
  WeightedEntity,
  WeightedTerm,
  WeightedTermSource,
} from './types.js';
import {
  PAGE_EVIDENCE_SCHEMA_VERSION,
  currentPageEvidenceVersions,
  type PageEvidenceExtractedRequest,
} from './types.js';

const MAX_TERMS = 64;
const MAX_KEYPHRASES = 32;
const MAX_ENTITIES = 32;
const MINHASH_SIZE = 32;

const STATIC_STOP_TOKENS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'above',
  'across',
  'after',
  'again',
  'against',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'between',
  'blog',
  'both',
  'but',
  'by',
  'can',
  'com',
  'could',
  'deleted',
  'docs',
  'do',
  'does',
  'don',
  'doing',
  'down',
  'during',
  'each',
  'edited',
  'every',
  'few',
  'field',
  'for',
  'from',
  'further',
  'ago',
  'has',
  'had',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'html',
  'http',
  'https',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'like',
  'may',
  'more',
  'most',
  'my',
  'net',
  'need',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'one',
  'only',
  'or',
  'org',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'page',
  'read',
  'same',
  'search',
  'she',
  'should',
  'so',
  'some',
  'such',
  'that',
  'than',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'us',
  'use',
  'used',
  'using',
  'very',
  've',
  'vp',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'www',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

interface TokenOccurrence {
  readonly term: string;
  readonly normalized: string;
  readonly source: WeightedTermSource;
}

interface TermAccumulator {
  readonly term: string;
  readonly normalized: string;
  readonly source: WeightedTermSource;
  readonly idf: number;
  tf: number;
  weight: number;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const rounded = (value: number): number => Number(value.toFixed(6));

const normalizeSpaces = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const hostForUrl = (raw: string): string => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
};

const pathTextForUrl = (raw: string): string => {
  try {
    return new URL(raw).pathname.split('/').map(safeDecode).join(' ');
  } catch {
    return raw;
  }
};

const normalizeToken = (value: string): string =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/^[^\p{L}\p{N}#+._/-]+|[^\p{L}\p{N}#+._/-]+$/gu, '')
    .toLowerCase();

const displayToken = (value: string): string =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/^[^\p{L}\p{N}#+._/-]+|[^\p{L}\p{N}#+._/-]+$/gu, '');

export const tokenizePageEvidenceText = (input: string): readonly string[] =>
  input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}#+._/-]+/u)
    .map(normalizeToken)
    .filter(
      (token) =>
        token.length >= 2 &&
        !/^\d+$/u.test(token) &&
        !/^\d+y$/u.test(token) &&
        !STATIC_STOP_TOKENS.has(token) &&
        !/^(?:amp|utm|ref)$/u.test(token),
    );

const looksTechnicalToken = (value: string): boolean =>
  /\d/u.test(value) || /[-_/+#.]/u.test(value) || /[a-z][A-Z]|[A-Z][a-z]+[A-Z]/u.test(value);

const occurrencesForText = (
  text: string,
  source: WeightedTermSource,
): readonly TokenOccurrence[] => {
  const out: TokenOccurrence[] = [];
  for (const raw of text.normalize('NFKC').split(/[^\p{L}\p{N}#+._/-]+/u)) {
    const term = displayToken(raw);
    const normalized = normalizeToken(raw);
    if (
      normalized.length < 2 ||
      /^\d+$/u.test(normalized) ||
      /^\d+y$/u.test(normalized) ||
      STATIC_STOP_TOKENS.has(normalized)
    ) {
      continue;
    }
    out.push({
      term,
      normalized,
      source,
    });
  }
  return out;
};

export const metadataTokensFor = (
  input: Pick<PageEvidenceMetadataInput, 'canonicalUrl' | 'url' | 'title'>,
): {
  readonly host: string;
  readonly pathTokens: readonly string[];
  readonly titleTokens: readonly string[];
} => {
  const url = input.canonicalUrl.length > 0 ? input.canonicalUrl : (input.url ?? '');
  return {
    host: hostForUrl(url),
    pathTokens: tokenizePageEvidenceText(pathTextForUrl(url)),
    titleTokens: tokenizePageEvidenceText(input.title ?? ''),
  };
};

const aggregateTerms = (
  occurrences: readonly TokenOccurrence[],
  input: { readonly userDocumentCount?: number },
): readonly WeightedTerm[] => {
  const byTerm = new Map<string, TermAccumulator>();
  for (const occurrence of occurrences) {
    const idf = blendedIdf({
      term: occurrence.normalized,
      userDocumentCount: input.userDocumentCount ?? 0,
    });
    const existing = byTerm.get(occurrence.normalized);
    if (existing === undefined) {
      byTerm.set(occurrence.normalized, {
        term: occurrence.term,
        normalized: occurrence.normalized,
        source: occurrence.source,
        idf,
        tf: 1,
        weight: idf,
      });
      continue;
    }
    existing.tf += 1;
    existing.weight += idf;
  }
  return [...byTerm.values()]
    .map((item) => ({
      term: item.term,
      normalized: item.normalized,
      weight: rounded(Math.log1p(item.tf) * item.weight),
      idf: rounded(item.idf),
      source: item.source,
    }))
    .sort(
      (left, right) => right.weight - left.weight || compareText(left.normalized, right.normalized),
    )
    .slice(0, MAX_TERMS);
};

const splitBodySections = (text: string): readonly string[] =>
  text
    .split(/\n{2,}/u)
    .map((part) => normalizeSpaces(part))
    .filter((part) => part.length > 0);

const bodyOccurrences = (text: string): readonly TokenOccurrence[] => {
  const sections = splitBodySections(text);
  const source = 'body' as const;
  const occurrences: TokenOccurrence[] = [];
  sections.forEach((section) => {
    occurrences.push(...occurrencesForText(section, source));
  });
  return occurrences;
};

const keyphraseCandidates = (
  tokens: readonly string[],
  topTermWeights: ReadonlyMap<string, WeightedTerm>,
): readonly WeightedTerm[] => {
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  const maxN = 4;
  for (let index = 0; index < tokens.length; index += 1) {
    for (let n = 2; n <= maxN; n += 1) {
      const slice = tokens.slice(index, index + n);
      if (slice.length !== n) continue;
      if (slice.some((token) => STATIC_STOP_TOKENS.has(token))) continue;
      const normalized = slice.join(' ');
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      display.set(normalized, slice.join(' '));
    }
  }
  const rows: WeightedTerm[] = [];
  for (const [normalized, count] of counts) {
    const parts = normalized.split(' ');
    const constituentWeight = parts.reduce(
      (sum, part) =>
        sum +
        (topTermWeights.get(part)?.weight ?? blendedIdf({ term: part, userDocumentCount: 0 })),
      0,
    );
    const containsTechnical = parts.some((part) => looksTechnicalToken(part));
    const keep = count >= 2 || containsTechnical || constituentWeight / parts.length >= 2.5;
    if (!keep) continue;
    const phraseLengthPenalty = 1 / Math.sqrt(parts.length);
    rows.push({
      term: display.get(normalized) ?? normalized,
      normalized,
      weight: rounded(constituentWeight * Math.log1p(count) * phraseLengthPenalty),
      source: 'body',
    });
  }
  return rows
    .sort(
      (left, right) => right.weight - left.weight || compareText(left.normalized, right.normalized),
    )
    .slice(0, MAX_KEYPHRASES);
};

const entitiesFor = (
  occurrences: readonly TokenOccurrence[],
  host: string,
): readonly WeightedEntity[] => {
  const rows = new Map<string, WeightedEntity>();
  const put = (entity: WeightedEntity): void => {
    const existing = rows.get(entity.normalized);
    if (existing === undefined || entity.weight > existing.weight)
      rows.set(entity.normalized, entity);
  };
  const hostTokens = host
    .split('.')
    .map(normalizeToken)
    .filter((token) => token.length >= 2 && !STATIC_STOP_TOKENS.has(token));
  const hostEntity = hostTokens.length >= 2 ? hostTokens.at(-2) : hostTokens[0];
  if (hostEntity !== undefined && hostEntity.length >= 2) {
    put({
      text: hostEntity,
      normalized: hostEntity,
      kind: 'unknown',
      weight: 1,
      source: 'host',
    });
  }
  for (const occurrence of occurrences) {
    const normalized = occurrence.normalized;
    const raw = occurrence.term;
    if (/^[A-Z]{2,}$/u.test(raw)) {
      put({
        text: raw,
        normalized,
        kind: 'acronym',
        weight: 1,
        source: occurrence.source === 'anchor' ? 'body' : occurrence.source,
      });
    } else if (/\d/u.test(raw) && /[A-Za-z]/u.test(raw)) {
      put({
        text: raw,
        normalized,
        kind: /\d+g$/iu.test(raw) ? 'standard' : 'product',
        weight: 1,
        source: occurrence.source === 'anchor' ? 'body' : occurrence.source,
      });
    } else if (/[A-Z][a-z]+[A-Z]/u.test(raw)) {
      put({
        text: raw,
        normalized,
        kind: 'product',
        weight: 1,
        source: occurrence.source === 'anchor' ? 'body' : occurrence.source,
      });
    }
  }
  return [...rows.values()]
    .sort(
      (left, right) => right.weight - left.weight || compareText(left.normalized, right.normalized),
    )
    .slice(0, MAX_ENTITIES);
};

const simhashFor = (terms: readonly WeightedTerm[]): string => {
  const bits = new Array<number>(64).fill(0);
  for (const term of terms) {
    const digest = createHash('sha256').update(term.normalized).digest();
    for (let index = 0; index < 64; index += 1) {
      const byte = digest[Math.floor(index / 8)] ?? 0;
      const bit = (byte >> (index % 8)) & 1;
      bits[index] = (bits[index] ?? 0) + (bit === 1 ? term.weight : -term.weight);
    }
  }
  let out = 0n;
  for (let index = 0; index < 64; index += 1) {
    if ((bits[index] ?? 0) >= 0) out |= 1n << BigInt(index);
  }
  return out.toString(16).padStart(16, '0');
};

const minhashFor = (tokens: readonly string[]): readonly number[] => {
  const unique = [...new Set(tokens)].sort(compareText);
  const hashes = unique
    .map((token) => createHash('sha256').update(token).digest().readUInt32BE(0))
    .sort((left, right) => left - right)
    .slice(0, MINHASH_SIZE);
  return hashes;
};

export const extractPageEvidenceFeatures = (input: {
  readonly canonicalUrl: string;
  readonly url?: string;
  readonly title?: string;
  readonly text?: string;
  readonly userDocumentCount?: number;
}): {
  readonly metadata: ReturnType<typeof metadataTokensFor>;
  readonly terms: readonly WeightedTerm[];
  readonly keyphrases: readonly WeightedTerm[];
  readonly entities: readonly WeightedEntity[];
  readonly simhash?: string;
  readonly minhash?: readonly number[];
} => {
  const metadata = metadataTokensFor(input);
  const title = input.title ?? '';
  const pathText = pathTextForUrl(input.canonicalUrl);
  const host = metadata.host;
  const text = input.text ?? '';
  const occurrences = [
    ...occurrencesForText(title, 'title'),
    ...occurrencesForText(pathText, 'url_path'),
    ...occurrencesForText(host, 'host'),
    ...bodyOccurrences(text),
  ];
  const terms = aggregateTerms(occurrences, {
    ...(input.userDocumentCount === undefined
      ? {}
      : { userDocumentCount: input.userDocumentCount }),
  });
  const topTermWeights = new Map(terms.map((term) => [term.normalized, term] as const));
  const phraseTokens = tokenizePageEvidenceText([title, pathText, text].join('\n'));
  const keyphrases = keyphraseCandidates(phraseTokens, topTermWeights);
  const entities = entitiesFor(occurrences, host);
  return {
    metadata,
    terms,
    keyphrases,
    entities,
    ...(terms.length === 0 ? {} : { simhash: simhashFor(terms) }),
    ...(phraseTokens.length === 0 ? {} : { minhash: minhashFor(phraseTokens) }),
  };
};

export const semanticFeatureRevisionFor = (
  record: Omit<
    PageEvidenceRecord,
    'semanticFeatureRevision' | 'behaviorMetadataRevision' | 'evidenceRevision'
  >,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: record.schemaVersion,
        canonicalUrl: record.canonicalUrl,
        evidenceTier: record.evidenceTier,
        versions: record.versions,
        semanticMetadata: {
          title: record.metadata.title,
          host: record.metadata.host,
          pathTokens: record.metadata.pathTokens,
          titleTokens: record.metadata.titleTokens,
        },
        contentHash: record.content?.contentHash,
        terms: record.content?.terms,
        keyphrases: record.content?.keyphrases,
        entities: record.content?.entities,
        docEmbeddingRef: record.content?.docEmbeddingRef,
        indexed: record.indexed,
        storageMode: record.evidenceTier,
      }),
    )
    .digest('hex')
    .slice(0, 24);

export const behaviorMetadataRevisionFor = (
  record: Omit<
    PageEvidenceRecord,
    'semanticFeatureRevision' | 'behaviorMetadataRevision' | 'evidenceRevision'
  >,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: record.schemaVersion,
        canonicalUrl: record.canonicalUrl,
        updatedAt: record.updatedAt,
        provider: record.metadata.provider,
        firstSeenAt: record.metadata.firstSeenAt,
        lastSeenAt: record.metadata.lastSeenAt,
        visitCount: record.metadata.visitCount,
        focusedWindowMs: record.metadata.focusedWindowMs,
        provenance: record.provenance,
      }),
    )
    .digest('hex')
    .slice(0, 24);

const finalizeRecord = (
  record: Omit<
    PageEvidenceRecord,
    'semanticFeatureRevision' | 'behaviorMetadataRevision' | 'evidenceRevision'
  >,
): PageEvidenceRecord => {
  const semanticFeatureRevision = semanticFeatureRevisionFor(record);
  const behaviorMetadataRevision = behaviorMetadataRevisionFor(record);
  return {
    ...record,
    semanticFeatureRevision,
    behaviorMetadataRevision,
    evidenceRevision: semanticFeatureRevision,
  };
};

export const buildMetadataOnlyEvidence = (
  input: PageEvidenceMetadataInput,
  previous?: PageEvidenceRecord,
): PageEvidenceRecord => {
  const metadata = metadataTokensFor(input);
  const updatedAt =
    input.lastSeenAt ?? input.firstSeenAt ?? previous?.updatedAt ?? new Date().toISOString();
  const title = input.title ?? previous?.metadata.title;
  const provider = input.provider ?? previous?.metadata.provider;
  const firstSeenAt = input.firstSeenAt ?? previous?.metadata.firstSeenAt;
  const lastSeenAt = input.lastSeenAt ?? previous?.metadata.lastSeenAt;
  const visitCount = input.visitCount ?? previous?.metadata.visitCount;
  const focusedWindowMs = input.focusedWindowMs ?? previous?.metadata.focusedWindowMs;
  const base = {
    schemaVersion: PAGE_EVIDENCE_SCHEMA_VERSION,
    canonicalUrl: input.canonicalUrl,
    updatedAt,
    evidenceTier:
      previous?.content === undefined ? ('metadata_only' as const) : previous.evidenceTier,
    versions: previous?.content === undefined ? currentPageEvidenceVersions() : previous.versions,
    metadata: {
      ...(title === undefined ? {} : { title }),
      host: metadata.host,
      pathTokens: metadata.pathTokens,
      titleTokens: metadata.titleTokens,
      ...(provider === undefined ? {} : { provider }),
      ...(firstSeenAt === undefined ? {} : { firstSeenAt }),
      ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
      ...(visitCount === undefined ? {} : { visitCount }),
      ...(focusedWindowMs === undefined ? {} : { focusedWindowMs }),
    },
    ...(previous?.content === undefined ? {} : { content: previous.content }),
    ...(previous?.indexed === undefined ? {} : { indexed: previous.indexed }),
    provenance: {
      sources: [...new Set([...(previous?.provenance.sources ?? []), 'timeline' as const])].sort(
        compareText,
      ),
      ...(previous?.provenance.sourceEventIds === undefined
        ? {}
        : { sourceEventIds: previous.provenance.sourceEventIds }),
      ...(previous?.provenance.modelRevision === undefined
        ? {}
        : { modelRevision: previous.provenance.modelRevision }),
    },
  } satisfies Omit<
    PageEvidenceRecord,
    'semanticFeatureRevision' | 'behaviorMetadataRevision' | 'evidenceRevision'
  >;
  return finalizeRecord(base);
};

export const buildExtractedPageEvidence = (
  payload: PageEvidenceExtractedRequest,
  previous?: PageEvidenceRecord,
  options: {
    readonly docEmbeddingRef?: VectorRef;
    readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
  } = {},
): PageEvidenceRecord => {
  const features = extractPageEvidenceFeatures({
    canonicalUrl: payload.canonicalUrl,
    url: payload.url,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    text: payload.content.text,
  });
  const metadata = features.metadata;
  const tier =
    payload.storageMode === 'indexed_chunks'
      ? ('indexed_chunks' as const)
      : ('content_features_only' as const);
  const base = {
    schemaVersion: PAGE_EVIDENCE_SCHEMA_VERSION,
    canonicalUrl: payload.canonicalUrl,
    updatedAt: payload.extractedAt,
    evidenceTier: tier,
    versions: currentPageEvidenceVersions(options.docEmbeddingRef),
    metadata: {
      ...(payload.title === undefined
        ? previous?.metadata.title === undefined
          ? {}
          : { title: previous.metadata.title }
        : { title: payload.title }),
      host: metadata.host,
      pathTokens: metadata.pathTokens,
      titleTokens: metadata.titleTokens,
      ...(payload.provider === undefined
        ? previous?.metadata.provider === undefined
          ? {}
          : { provider: previous.metadata.provider }
        : { provider: payload.provider }),
      ...(previous?.metadata.firstSeenAt === undefined
        ? { firstSeenAt: payload.extractedAt }
        : { firstSeenAt: previous.metadata.firstSeenAt }),
      lastSeenAt: payload.extractedAt,
      ...(previous?.metadata.visitCount === undefined
        ? {}
        : { visitCount: previous.metadata.visitCount }),
      ...(previous?.metadata.focusedWindowMs === undefined
        ? {}
        : { focusedWindowMs: previous.metadata.focusedWindowMs }),
    },
    content: {
      contentHash: payload.content.contentHash,
      extractionSource: payload.extractionSource,
      quality: payload.quality,
      qualitySignals: payload.qualitySignals,
      terms: features.terms,
      keyphrases: features.keyphrases,
      entities: features.entities,
      ...(options.docEmbeddingRef === undefined
        ? {}
        : { docEmbeddingRef: options.docEmbeddingRef }),
      ...(options.embeddingState === undefined ? {} : { embeddingState: options.embeddingState }),
      ...(features.simhash === undefined ? {} : { simhash: features.simhash }),
      ...(features.minhash === undefined ? {} : { minhash: features.minhash }),
    },
    ...(tier === 'indexed_chunks'
      ? {
          indexed: {
            chunkCount: Math.max(
              1,
              Math.ceil(Math.min(payload.content.text.length, 100_000) / 1_200),
            ),
            indexedCharCount: Math.min(payload.content.text.length, 100_000),
            chunkManifestRef: `${payload.content.contentHash}.json`,
          },
        }
      : {}),
    provenance: {
      sources:
        tier === 'indexed_chunks'
          ? (['page-content', 'indexed-chunks'] as const)
          : (['page-content'] as const),
    },
  } satisfies Omit<
    PageEvidenceRecord,
    'semanticFeatureRevision' | 'behaviorMetadataRevision' | 'evidenceRevision'
  >;
  return finalizeRecord(base);
};

export const evidenceCorpusForRecord = (record: PageEvidenceRecord): string => {
  const pieces = [
    record.metadata.title ?? '',
    record.metadata.host,
    ...record.metadata.pathTokens,
    ...record.metadata.titleTokens,
    ...(record.content?.terms ?? []).map((term) => term.term),
    ...(record.content?.keyphrases ?? []).map((term) => term.term),
    ...(record.content?.entities ?? []).map((entity) => entity.text),
  ];
  return normalizeSpaces(pieces.join(' '));
};

export const evidenceTokensForRecord = (record: PageEvidenceRecord): readonly WeightedTerm[] => {
  const metadataTerms: WeightedTerm[] = [
    ...record.metadata.titleTokens.map((term) => ({
      term,
      normalized: term,
      weight: 1,
      source: 'title' as const,
    })),
    ...record.metadata.pathTokens.map((term) => ({
      term,
      normalized: term,
      weight: 1,
      source: 'url_path' as const,
    })),
    ...(record.metadata.host.length === 0
      ? []
      : record.metadata.host.split('.').map((term) => ({
          term,
          normalized: term,
          weight: 1,
          source: 'host' as const,
        }))),
  ];
  return [
    ...(record.content?.terms ?? []),
    ...(record.content?.keyphrases ?? []),
    ...metadataTerms,
  ];
};
