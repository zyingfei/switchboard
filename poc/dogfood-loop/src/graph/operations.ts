import { buildMarkdownPatchPreview, type BranchArtifact, type PatchMode } from '../patch/markdownPatch';
import { createId } from '../shared/ids';
import { nowIso } from '../shared/time';
import type {
  GraphStore,
  JsonValue,
  PromptRun,
  WorkstreamEdge,
  WorkstreamEvent,
  WorkstreamNode,
} from './model';

export interface ForkTarget {
  provider: string;
  title: string;
  targetUrl: string;
  promptText?: string;
  tabId?: number;
}

export interface ForkResult {
  note: WorkstreamNode;
  threads: WorkstreamNode[];
  promptRuns: PromptRun[];
  edges: WorkstreamEdge[];
}

export const CURRENT_NOTE_ID_META_KEY = 'currentNoteId';
export const ACTIVE_PATCH_ID_META_KEY = 'activePatchId';
export const LATEST_CONVERGENCE_ID_META_KEY = 'latestConvergenceId';

export const appendEvent = async (
  store: GraphStore,
  type: string,
  entityId?: string,
  payload?: JsonValue,
): Promise<WorkstreamEvent> => {
  const event = {
    id: createId('event'),
    type,
    entityId,
    payload,
    createdAt: nowIso(),
  } satisfies WorkstreamEvent;
  await store.appendEvent(event);
  return event;
};

export const createOrUpdateCurrentNote = async (
  store: GraphStore,
  content: string,
): Promise<WorkstreamNode> => {
  const existingId = await store.getMeta<string>(CURRENT_NOTE_ID_META_KEY);
  const existing = existingId ? await store.getNode(existingId) : null;
  const at = nowIso();
  const note = {
    id: existing?.id ?? createId('note'),
    type: 'note',
    title: 'Local markdown note',
    content,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  } satisfies WorkstreamNode;
  await store.saveNode(note);
  await store.setMeta(CURRENT_NOTE_ID_META_KEY, note.id);
  await appendEvent(store, existing ? 'note.updated' : 'note.created', note.id);
  return note;
};

export const getCurrentNote = async (store: GraphStore): Promise<WorkstreamNode | null> => {
  const id = await store.getMeta<string>(CURRENT_NOTE_ID_META_KEY);
  return id ? await store.getNode(id) : null;
};

export const buildPromptText = (noteContent: string, targetTitle: string): string =>
  [
    `You are ${targetTitle}, a mock review branch for the browser-ai-companion POC.`,
    'Review the source note. Return concise, actionable product feedback.',
    '',
    'Source note:',
    noteContent,
  ].join('\n');

export const createForkForTargets = async (
  store: GraphStore,
  noteContent: string,
  targets: ForkTarget[],
): Promise<ForkResult> => {
  const note = await createOrUpdateCurrentNote(store, noteContent);
  const threads: WorkstreamNode[] = [];
  const promptRuns: PromptRun[] = [];
  const edges: WorkstreamEdge[] = [];

  for (const target of targets) {
    const at = nowIso();
    const thread = {
      id: createId('thread'),
      type: 'chat_thread',
      title: target.title,
      url: target.targetUrl,
      provider: target.provider,
      metadata: target.tabId === undefined ? undefined : { tabId: target.tabId },
      createdAt: at,
      updatedAt: at,
    } satisfies WorkstreamNode;
    const runId = createId('run');
    const promptRun = {
      id: runId,
      sourceNoteId: note.id,
      targetThreadId: thread.id,
      promptText: target.promptText ?? buildPromptText(noteContent, target.title),
      status: 'queued',
      createdAt: at,
    } satisfies PromptRun;
    const promptRunNode = {
      id: runId,
      type: 'prompt_run',
      title: `Prompt run for ${target.title}`,
      content: promptRun.promptText,
      provider: target.provider,
      metadata: { sourceNoteId: note.id, targetThreadId: thread.id },
      createdAt: at,
      updatedAt: at,
    } satisfies WorkstreamNode;
    const edge = {
      id: createId('edge'),
      fromNodeId: note.id,
      toNodeId: thread.id,
      type: 'forked_to',
      createdAt: at,
    } satisfies WorkstreamEdge;

    await store.saveNode(thread);
    await store.saveNode(promptRunNode);
    await store.savePromptRun(promptRun);
    await store.saveEdge(edge);
    await appendEvent(store, 'fork.created', promptRun.id, {
      provider: target.provider,
      threadId: thread.id,
    });

    threads.push(thread);
    promptRuns.push(promptRun);
    edges.push(edge);
  }

  return { note, threads, promptRuns, edges };
};

export const updatePromptRunStatus = async (
  store: GraphStore,
  runId: string,
  status: PromptRun['status'],
  failureReason?: string,
): Promise<PromptRun> => {
  const run = await store.getPromptRun(runId);
  if (!run) {
    throw new Error(`Prompt run not found: ${runId}`);
  }
  const next = {
    ...run,
    status,
    failureReason,
    completedAt: status === 'done' || status === 'failed' ? nowIso() : run.completedAt,
  } satisfies PromptRun;
  await store.savePromptRun(next);
  await appendEvent(store, `run.${status}`, runId, failureReason ? { failureReason } : undefined);
  return next;
};

export const attachThreadTab = async (
  store: GraphStore,
  threadId: string,
  url: string,
  tabId: number,
): Promise<WorkstreamNode> => {
  const thread = await store.getNode(threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }
  const next = {
    ...thread,
    url,
    metadata: {
      ...(thread.metadata ?? {}),
      tabId,
    },
    updatedAt: nowIso(),
  } satisfies WorkstreamNode;
  await store.saveNode(next);
  return next;
};

export const recordChatResponse = async (
  store: GraphStore,
  runId: string,
  provider: string,
  title: string,
  content: string,
): Promise<WorkstreamNode> => {
  const run = await store.getPromptRun(runId);
  if (!run) {
    throw new Error(`Prompt run not found: ${runId}`);
  }
  const at = nowIso();
  const response = {
    id: createId('response'),
    type: 'chat_response',
    title,
    content,
    provider,
    metadata: { runId },
    createdAt: at,
    updatedAt: at,
  } satisfies WorkstreamNode;
  const edge = {
    id: createId('edge'),
    fromNodeId: run.targetThreadId,
    toNodeId: response.id,
    type: 'responded_with',
    createdAt: at,
  } satisfies WorkstreamEdge;
  await store.saveNode(response);
  await store.saveEdge(edge);
  await updatePromptRunStatus(store, runId, 'done');
  await appendEvent(store, 'response.recorded', response.id, { provider, runId });
  return response;
};

export const listBranchArtifacts = async (store: GraphStore): Promise<BranchArtifact[]> => {
  const nodes = await store.listNodes();
  return nodes
    .filter((node) => node.type === 'chat_response' && node.content && node.provider)
    .map((node) => ({
      provider: node.provider ?? '',
      title: node.title,
      content: node.content ?? '',
    }));
};

export const createConvergence = async (
  store: GraphStore,
  mode: PatchMode,
): Promise<WorkstreamNode> => {
  const note = await getCurrentNote(store);
  if (!note) {
    throw new Error('No source note exists yet');
  }
  const branches = await listBranchArtifacts(store);
  const selected = buildMarkdownPatchPreview(note.content ?? '', branches, mode);
  const at = nowIso();
  const convergence = {
    id: createId('convergence'),
    type: 'convergence',
    title: `Convergence: ${mode}`,
    content: selected.proposed,
    metadata: {
      mode,
      branchCount: branches.length,
    },
    createdAt: at,
    updatedAt: at,
  } satisfies WorkstreamNode;
  const edge = {
    id: createId('edge'),
    fromNodeId: note.id,
    toNodeId: convergence.id,
    type: 'converged_into',
    createdAt: at,
  } satisfies WorkstreamEdge;
  await store.saveNode(convergence);
  await store.saveEdge(edge);
  await store.setMeta(LATEST_CONVERGENCE_ID_META_KEY, convergence.id);
  await appendEvent(store, 'convergence.created', convergence.id, { mode });
  return convergence;
};

export const createPatchPreview = async (
  store: GraphStore,
  mode: PatchMode,
): Promise<WorkstreamNode> => {
  const note = await getCurrentNote(store);
  if (!note) {
    throw new Error('No source note exists yet');
  }
  const convergence = await createConvergence(store, mode);
  const branches = await listBranchArtifacts(store);
  const preview = buildMarkdownPatchPreview(note.content ?? '', branches, mode);
  const at = nowIso();
  const patch = {
    id: createId('patch'),
    type: 'patch',
    title: `Patch preview: ${mode}`,
    content: JSON.stringify(preview),
    metadata: {
      mode,
      originalLength: preview.original.length,
      proposedLength: preview.proposed.length,
    },
    createdAt: at,
    updatedAt: at,
  } satisfies WorkstreamNode;
  const edge = {
    id: createId('edge'),
    fromNodeId: convergence.id,
    toNodeId: patch.id,
    type: 'patched',
    createdAt: at,
  } satisfies WorkstreamEdge;
  await store.saveNode(patch);
  await store.saveEdge(edge);
  await store.setMeta(ACTIVE_PATCH_ID_META_KEY, patch.id);
  await appendEvent(store, 'patch.previewed', patch.id, { mode });
  return patch;
};

export const parsePatchNodeContent = (
  patch: WorkstreamNode | null,
): { mode: PatchMode; original: string; proposed: string } | null => {
  if (!patch?.content) {
    return null;
  }
  const parsed = JSON.parse(patch.content) as Partial<{
    mode: PatchMode;
    original: string;
    proposed: string;
  }>;
  if (
    (parsed.mode === 'useA' || parsed.mode === 'useB' || parsed.mode === 'appendBoth') &&
    typeof parsed.original === 'string' &&
    typeof parsed.proposed === 'string'
  ) {
    return parsed as { mode: PatchMode; original: string; proposed: string };
  }
  return null;
};

export const getActivePatchPreview = async (
  store: GraphStore,
): Promise<{ mode: PatchMode; original: string; proposed: string } | null> => {
  const patchId = await store.getMeta<string>(ACTIVE_PATCH_ID_META_KEY);
  return parsePatchNodeContent(patchId ? await store.getNode(patchId) : null);
};

export const acceptActivePatch = async (store: GraphStore): Promise<WorkstreamNode> => {
  const patchId = await store.getMeta<string>(ACTIVE_PATCH_ID_META_KEY);
  const patch = patchId ? await store.getNode(patchId) : null;
  const preview = parsePatchNodeContent(patch);
  if (!patch || !preview) {
    throw new Error('No active patch preview exists');
  }
  const note = await createOrUpdateCurrentNote(store, preview.proposed);
  const edge = {
    id: createId('edge'),
    fromNodeId: patch.id,
    toNodeId: note.id,
    type: 'patched',
    createdAt: nowIso(),
  } satisfies WorkstreamEdge;
  await store.saveEdge(edge);
  await store.setMeta(ACTIVE_PATCH_ID_META_KEY, null);
  await appendEvent(store, 'patch.accepted', patch.id, { noteId: note.id });
  return note;
};
