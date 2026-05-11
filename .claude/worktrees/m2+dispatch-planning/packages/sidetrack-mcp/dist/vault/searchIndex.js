import MiniSearch from 'minisearch';
let cachedIndex;
const stemTerm = (term) => {
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
const excerpt = (...values) => values
    .filter((value) => value !== undefined && value.length > 0)
    .join(' ')
    .slice(0, 240);
const buildDocuments = (snapshot) => [
    ...snapshot.threads.map((thread) => ({
        searchId: `thread:${thread.bac_id}`,
        kind: 'thread',
        id: thread.bac_id,
        title: thread.title ?? thread.threadUrl ?? thread.bac_id,
        body: excerpt(thread.title, thread.threadUrl, thread.provider),
        tags: (thread.tags ?? []).join(' '),
        excerpt: excerpt(thread.title, thread.threadUrl, thread.provider, ...(thread.tags ?? [])),
    })),
    ...snapshot.queueItems.map((item) => ({
        searchId: `queue:${item.bac_id}`,
        kind: 'queue',
        id: item.bac_id,
        title: item.text ?? item.bac_id,
        body: excerpt(item.text, item.scope, item.targetId, item.status),
        tags: '',
        excerpt: excerpt(item.text, item.scope, item.targetId, item.status),
    })),
    ...snapshot.reminders.map((reminder) => ({
        searchId: `reminder:${reminder.bac_id}`,
        kind: 'reminder',
        id: reminder.bac_id,
        title: reminder.threadId ?? reminder.bac_id,
        body: excerpt(reminder.threadId, reminder.provider, reminder.status),
        tags: '',
        excerpt: excerpt(reminder.threadId, reminder.provider, reminder.status),
    })),
];
export const buildIndex = (snapshot) => {
    if (cachedIndex?.generatedAt === snapshot.generatedAt) {
        return cachedIndex.index;
    }
    const index = new MiniSearch({
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
export const searchIndex = (snapshot, query) => {
    if (query.trim().length === 0) {
        return [];
    }
    return buildIndex(snapshot)
        .search(query)
        .map((result) => {
        const stored = result;
        return {
            kind: stored.kind,
            id: stored.id,
            title: stored.title,
            score: stored.score,
            excerpt: stored.excerpt,
        };
    });
};
//# sourceMappingURL=searchIndex.js.map