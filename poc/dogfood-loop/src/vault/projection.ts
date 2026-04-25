import type { PromptRun, WorkstreamEdge, WorkstreamEvent, WorkstreamNode } from '../graph/model';
import type { ThreadRegistryEntry } from '../registry/threadRegistry';

export interface ProjectedFile {
  path: string;
  content: string;
}

export interface VaultProjection {
  generatedAt: string;
  files: ProjectedFile[];
}

export interface VaultProjectionInput {
  nodes: WorkstreamNode[];
  edges: WorkstreamEdge[];
  promptRuns: PromptRun[];
  events: WorkstreamEvent[];
  threadRegistry: ThreadRegistryEntry[];
  generatedAt: string;
}

const yamlString = (value: string): string => JSON.stringify(value);

const eventLogPath = (generatedAt: string): string => `_BAC/events/${generatedAt.slice(0, 10)}.jsonl`;

const buildEventLog = (events: WorkstreamEvent[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');

const buildWorkstreamMarkdown = (
  nodes: WorkstreamNode[],
  edges: WorkstreamEdge[],
  promptRuns: PromptRun[],
  generatedAt: string,
): string => {
  const note = nodes.find((node) => node.type === 'note');
  const responses = nodes.filter((node) => node.type === 'chat_response');
  const sources = nodes.filter((node) => node.type === 'source');
  return [
    '---',
    'bac_type: workstream',
    `bac_generated_at: ${yamlString(generatedAt)}`,
    `source_note_id: ${yamlString(note?.id ?? '')}`,
    `prompt_runs: ${promptRuns.length}`,
    `context_edges: ${edges.length}`,
    '---',
    '',
    '# BAC Workstream Projection',
    '',
    '## Source Note',
    '',
    note?.content ?? '_No source note yet._',
    '',
    '## Prompt Runs',
    '',
    ...promptRuns.map((run) => `- ${run.id}: ${run.status} -> ${run.targetThreadId}`),
    '',
    '## Adopted Sources',
    '',
    ...sources.map((node) => `- ${node.title}: ${node.url ?? ''}`),
    '',
    '## Branch Artifacts',
    '',
    ...responses.map((node) => `### ${node.title}\n\n${node.content ?? ''}\n`),
  ].join('\n');
};

const buildWhereWasIBase = (
  threadRegistry: ThreadRegistryEntry[],
  generatedAt: string,
): string =>
  JSON.stringify(
    {
      bac_type: 'where_was_i_base_projection',
      generatedAt,
      views: [
        {
          name: 'Where Was I',
          type: 'table',
          rows: threadRegistry.map((thread) => ({
            provider: thread.provider,
            title: thread.title,
            status: thread.status,
            lastSpeaker: thread.lastSpeaker,
            selectorCanary: thread.selectorCanary,
            url: thread.url,
          })),
        },
      ],
    },
    null,
    2,
  ) + '\n';

export const buildVaultProjection = ({
  nodes,
  edges,
  promptRuns,
  events,
  threadRegistry,
  generatedAt,
}: VaultProjectionInput): VaultProjection => ({
  generatedAt,
  files: [
    {
      path: eventLogPath(generatedAt),
      content: buildEventLog(events),
    },
    {
      path: '_BAC/workstreams/current.md',
      content: buildWorkstreamMarkdown(nodes, edges, promptRuns, generatedAt),
    },
    {
      path: '_BAC/where-was-i.base',
      content: buildWhereWasIBase(threadRegistry, generatedAt),
    },
  ],
});
