export type NodeType =
  | 'note'
  | 'prompt_run'
  | 'chat_thread'
  | 'chat_response'
  | 'source'
  | 'convergence'
  | 'patch';

export type EdgeType = 'forked_to' | 'responded_with' | 'converged_into' | 'patched';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WorkstreamNode {
  id: string;
  type: NodeType;
  title: string;
  content?: string;
  url?: string;
  provider?: string;
  metadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkstreamEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: EdgeType;
  createdAt: string;
}

export interface PromptRun {
  id: string;
  sourceNoteId: string;
  targetThreadId: string;
  promptText: string;
  status: 'queued' | 'injected' | 'waiting' | 'done' | 'failed';
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface WorkstreamEvent {
  id: string;
  type: string;
  entityId?: string;
  payload?: JsonValue;
  createdAt: string;
}

export interface GraphStore {
  saveNode(node: WorkstreamNode): Promise<void>;
  getNode(id: string): Promise<WorkstreamNode | null>;
  listNodes(): Promise<WorkstreamNode[]>;
  saveEdge(edge: WorkstreamEdge): Promise<void>;
  listEdges(): Promise<WorkstreamEdge[]>;
  savePromptRun(run: PromptRun): Promise<void>;
  getPromptRun(id: string): Promise<PromptRun | null>;
  listPromptRuns(): Promise<PromptRun[]>;
  appendEvent(event: WorkstreamEvent): Promise<void>;
  listEvents(): Promise<WorkstreamEvent[]>;
  getMeta<T extends JsonValue>(key: string): Promise<T | null>;
  setMeta<T extends JsonValue>(key: string, value: T | null): Promise<void>;
  clear(): Promise<void>;
}
