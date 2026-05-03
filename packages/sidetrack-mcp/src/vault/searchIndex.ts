import MiniSearch from 'minisearch';

import type { LiveVaultSnapshot } from './liveVaultReader.js';

export interface SearchHit {
  readonly kind: 'thread' | 'queue' | 'reminder';
  readonly id: string;
  readonly title: string;
  readonly score: number;
  readonly excerpt: string;
}

interface SearchDocument {
  readonly searchId: string;
  readonly kind: SearchHit['kind'];
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly excerpt: string;
}

type SearchIndex = MiniSearch<SearchDocument>;

let cachedIndex:
  | {
      readonly generatedAt: string;
      readonly index: SearchIndex;
    }
  | undefined;

const stemTerm = (term: string): string => {
  const normalized = term.toLowerCase();
  if (normalized.length > 6 && normalized.endsWith('ing')) {
    return normalized.slice(0, -3);
  }
  if (normalized.length > 6 && normalized.endsWith('ion')) {
    return normalized.slice(0, -3);
  }
  if (normalized.length > 6 && normalized.endsWith('ed')) {
    return normalized.slice(0, -2);
  }
  if (normalized.length > 4 && normalized.endsWith('s')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const excerpt = (...values: readonly (string | undefined)[]): string =>
  values
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(' ')
    .slice(0, 240);

const buildDocuments = (snapshot: LiveVaultSnapshot): readonly SearchDocument[] => [
  ...snapshot.threads.map((thread) => ({
    searchId: `thread:${thread.bac_id}`,
    kind: 'thread' as const,
    id: thread.bac_id,
    title: thread.title ?? thread.threadUrl ?? thread.bac_id,
    body: excerpt(thread.title, thread.threadUrl, thread.provider),
    tags: (thread.tags ?? []).join(' '),
    excerpt: excerpt(thread.title, thread.threadUrl, thread.provider, ...(thread.tags ?? [])),
  })),
  ...snapshot.queueItems.map((item) => ({
    searchId: `queue:${item.bac_id}`,
    kind: 'queue' as const,
    id: item.bac_id,
    title: item.text ?? item.bac_id,
    body: excerpt(item.text, item.scope, item.targetId, item.status),
    tags: '',
    excerpt: excerpt(item.text, item.scope, item.targetId, item.status),
  })),
  ...snapshot.reminders.map((reminder) => ({
    searchId: `reminder:${reminder.bac_id}`,
    kind: 'reminder' as const,
    id: reminder.bac_id,
    title: reminder.threadId ?? reminder.bac_id,
    body: excerpt(reminder.threadId, reminder.provider, reminder.status),
    tags: '',
    excerpt: excerpt(reminder.threadId, reminder.provider, reminder.status),
  })),
];

export const buildIndex = (snapshot: LiveVaultSnapshot): SearchIndex => {
  if (cachedIndex?.generatedAt === snapshot.generatedAt) {
    return cachedIndex.index;
  }

  const index = new MiniSearch<SearchDocument>({
    idField: 'searchId',
    fields: ['title', 'body', 'tags'],
    storeFields: ['kind', 'id', 'title', 'excerpt'],
    processTerm: stemTerm,
    searchOptions: {
      boost: { title: 2 },
      prefix: true,
    },
  });
  index.addAll(buildDocuments(snapshot));
  cachedIndex = { generatedAt: snapshot.generatedAt, index };
  return index;
};

export const searchIndex = (snapshot: LiveVaultSnapshot, query: string): readonly SearchHit[] => {
  if (query.trim().length === 0) {
    return [];
  }

  return buildIndex(snapshot)
    .search(query)
    .map((result) => {
      const stored = result as unknown as Pick<
        SearchDocument,
        'kind' | 'id' | 'title' | 'excerpt'
      > & { readonly score: number };
      return {
        kind: stored.kind,
        id: stored.id,
        title: stored.title,
        score: stored.score,
        excerpt: stored.excerpt,
      };
    });
};
