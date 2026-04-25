import type {
  GraphStore,
  JsonValue,
  PromptRun,
  WorkstreamEdge,
  WorkstreamEvent,
  WorkstreamNode,
} from './model';

export const createMemoryGraphStore = (): GraphStore => {
  const nodes = new Map<string, WorkstreamNode>();
  const edges = new Map<string, WorkstreamEdge>();
  const runs = new Map<string, PromptRun>();
  const events = new Map<string, WorkstreamEvent>();
  const meta = new Map<string, JsonValue>();

  return {
    async saveNode(node) {
      nodes.set(node.id, structuredClone(node));
    },
    async getNode(id) {
      const node = nodes.get(id);
      return node ? structuredClone(node) : null;
    },
    async listNodes() {
      return Array.from(nodes.values())
        .map((node) => structuredClone(node))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async saveEdge(edge) {
      edges.set(edge.id, structuredClone(edge));
    },
    async listEdges() {
      return Array.from(edges.values())
        .map((edge) => structuredClone(edge))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async savePromptRun(run) {
      runs.set(run.id, structuredClone(run));
    },
    async getPromptRun(id) {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    async listPromptRuns() {
      return Array.from(runs.values())
        .map((run) => structuredClone(run))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async appendEvent(event) {
      events.set(event.id, structuredClone(event));
    },
    async listEvents() {
      return Array.from(events.values())
        .map((event) => structuredClone(event))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async getMeta(key) {
      const value = meta.get(key);
      return value === undefined ? null : (structuredClone(value) as never);
    },
    async setMeta(key, value) {
      if (value === null) {
        meta.delete(key);
        return;
      }
      meta.set(key, structuredClone(value));
    },
    async clear() {
      nodes.clear();
      edges.clear();
      runs.clear();
      events.clear();
      meta.clear();
    },
  };
};
