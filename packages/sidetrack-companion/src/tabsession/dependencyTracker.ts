export interface ResolverDependencyKey {
  readonly tabSessionId: string;
  readonly graphRevision: string;
  readonly rankerRevision?: string;
  readonly topicRevision?: string;
  readonly feedbackRevision: string;
  readonly modelRevision?: string;
}

export const resolverDependencyCacheKey = (key: ResolverDependencyKey): string =>
  [
    key.tabSessionId,
    key.graphRevision,
    key.rankerRevision ?? 'ranker:none',
    key.topicRevision ?? 'topic:none',
    key.feedbackRevision,
    key.modelRevision ?? 'model:none',
  ].join('|');

export const createResolverInvalidationQueue = (): {
  readonly enqueue: (key: ResolverDependencyKey) => void;
  readonly drain: () => readonly ResolverDependencyKey[];
} => {
  const queue = new Map<string, ResolverDependencyKey>();
  return {
    enqueue: (key) => {
      queue.set(resolverDependencyCacheKey(key), key);
    },
    drain: () => {
      const items = [...queue.values()];
      queue.clear();
      return items;
    },
  };
};
