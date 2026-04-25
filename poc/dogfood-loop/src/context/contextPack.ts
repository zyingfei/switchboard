import type { PromptRun, WorkstreamEvent, WorkstreamNode } from '../graph/model';
import type { ThreadRegistryEntry } from '../registry/threadRegistry';

export interface ContextPack {
  generatedAt: string;
  markdown: string;
  eventLogSlice: string;
}

export interface ContextPackInput {
  note: WorkstreamNode | null;
  responses: WorkstreamNode[];
  sources?: WorkstreamNode[];
  promptRuns: PromptRun[];
  events: WorkstreamEvent[];
  threadRegistry: ThreadRegistryEntry[];
  generatedAt: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body.trim() || '_None._'}\n`;

export const buildContextPack = ({
  note,
  responses,
  sources = [],
  promptRuns,
  events,
  threadRegistry,
  generatedAt,
}: ContextPackInput): ContextPack => {
  const eventLogSlice = events.map((event) => JSON.stringify(event)).join('\n');
  const markdown = [
    '# BAC Context Pack',
    '',
    `Generated: ${generatedAt}`,
    'Redaction status: POC regex preflight applied before dispatch.',
    '',
    section('Goal', note?.content ?? ''),
    section(
      'Prompt Runs',
      promptRuns.map((run) => `- ${run.id}: ${run.status}; prompt="${run.promptText.slice(0, 120)}"`).join('\n'),
    ),
    section(
      'Prior AI / Search Outputs',
      responses.map((response) => `### ${response.title}\n\n${response.content ?? ''}`).join('\n\n'),
    ),
    section(
      'Adopted Sources',
      sources.map((source) => `- ${source.title}: ${source.url ?? 'no URL'}`).join('\n'),
    ),
    section(
      'Open Threads',
      threadRegistry
        .map((thread) => `- ${thread.provider}: ${thread.title} (${thread.status}, ${thread.url})`)
        .join('\n'),
    ),
    section('Signed Event Log Slice (POC unsigned)', eventLogSlice),
  ].join('\n');
  return {
    generatedAt,
    markdown,
    eventLogSlice: eventLogSlice + (eventLogSlice ? '\n' : ''),
  };
};
