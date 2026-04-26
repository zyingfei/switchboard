import { promises as fs } from 'node:fs';

import {
  normalizeProviderCapture,
  providerLabels,
  type ProviderCapture,
} from '../../../provider-capture/src/capture/model';
import type { PromptRun, WorkstreamNode } from '../../../dogfood-loop/src/graph/model';
import type { ThreadRegistryEntry } from '../../../dogfood-loop/src/registry/threadRegistry';

const captureSort = (left: ProviderCapture, right: ProviderCapture): number =>
  right.capturedAt.localeCompare(left.capturedAt);

const readLastSpeaker = (capture: ProviderCapture): ThreadRegistryEntry['lastSpeaker'] => {
  const role = capture.turns[capture.turns.length - 1]?.role;
  if (role === 'assistant' || role === 'user') {
    return role;
  }
  return 'unknown';
};

const readThreadStatus = (capture: ProviderCapture): ThreadRegistryEntry['status'] => {
  if (capture.selectorCanary === 'failed') {
    return 'fallback';
  }
  const lastSpeaker = readLastSpeaker(capture);
  if (lastSpeaker === 'assistant') {
    return 'waiting_on_user';
  }
  if (lastSpeaker === 'user') {
    return 'waiting_on_ai';
  }
  return 'active';
};

const assistantContent = (capture: ProviderCapture): string => {
  const turns = capture.turns
    .filter((turn) => turn.role === 'assistant')
    .map((turn) => turn.formattedText?.trim() || turn.text.trim())
    .filter(Boolean);
  const artifacts = capture.artifacts
    .map((artifact) =>
      [
        `# ${artifact.title}`,
        '',
        `- Parent capture: ${capture.title}`,
        `- Provider: ${providerLabels[capture.provider]}`,
        `- Captured at: ${capture.capturedAt}`,
        `- Kind: ${artifact.kind}`,
        ...(artifact.sourceUrl ? [`- Source URL: ${artifact.sourceUrl}`] : []),
        '',
        artifact.formattedText.trim() || artifact.text.trim(),
      ]
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
  return [...turns, ...artifacts].join('\n\n').trim();
};

const firstUserPrompt = (capture: ProviderCapture): string | null => {
  const turns = capture.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.formattedText?.trim() || turn.text.trim())
    .filter(Boolean);
  return turns.length > 0 ? turns.join('\n\n') : null;
};

export const loadProviderCaptures = async (capturesPath: string): Promise<ProviderCapture[]> => {
  const raw = JSON.parse(await fs.readFile(capturesPath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Provider captures must be a JSON array: ${capturesPath}`);
  }
  return raw.map(normalizeProviderCapture).sort(captureSort);
};

export const capturesToThreadRegistryEntries = (captures: ProviderCapture[]): ThreadRegistryEntry[] =>
  captures
    .filter(
      (capture): capture is ProviderCapture & { provider: ThreadRegistryEntry['provider'] } =>
        capture.provider === 'chatgpt' || capture.provider === 'claude' || capture.provider === 'gemini',
    )
    .map((capture, index) => ({
      id: `${capture.provider}:${capture.id}`,
      provider: capture.provider,
      title: capture.title,
      url: capture.url,
      tabId: index + 1,
      lastSpeaker: readLastSpeaker(capture),
      status: readThreadStatus(capture),
      selectorCanary: capture.selectorCanary === 'failed' ? 'unsupported' : capture.selectorCanary,
      updatedAt: capture.capturedAt,
    }));

export const capturesToResponseNodes = (captures: ProviderCapture[]): WorkstreamNode[] =>
  captures.reduce<WorkstreamNode[]>((nodes, capture) => {
    const content = assistantContent(capture);
    if (!content) {
      return nodes;
    }
    nodes.push({
      id: `capture-response:${capture.id}`,
      type: 'chat_response',
      title: `${providerLabels[capture.provider]} capture: ${capture.title}`,
      content,
      url: capture.url,
      provider: capture.provider,
      metadata: {
        captureId: capture.id,
        selectorCanary: capture.selectorCanary,
      },
      createdAt: capture.capturedAt,
      updatedAt: capture.capturedAt,
    });
    return nodes;
  }, []);

export const capturesToSourceNodes = (captures: ProviderCapture[]): WorkstreamNode[] =>
  captures.flatMap((capture) =>
    capture.artifacts.map((artifact) => ({
      id: `capture-artifact:${capture.id}:${artifact.id}`,
      type: 'source' as const,
      title: `${providerLabels[capture.provider]} artifact: ${artifact.title}`,
      content: artifact.formattedText?.trim() || artifact.text.trim(),
      url: artifact.sourceUrl || artifact.links[0]?.url || capture.url,
      provider: capture.provider,
      metadata: {
        captureId: capture.id,
        artifactKind: artifact.kind,
      },
      createdAt: capture.capturedAt,
      updatedAt: capture.capturedAt,
    })),
  );

export const capturesToPromptRuns = (captures: ProviderCapture[], sourceNoteId: string): PromptRun[] =>
  captures.flatMap((capture) => {
    const promptText = firstUserPrompt(capture);
    if (!promptText) {
      return [];
    }
    return [
      {
        id: `prompt-run:${capture.id}`,
        sourceNoteId,
        targetThreadId: `thread:${capture.provider}:${capture.id}`,
        promptText,
        status: 'done' as const,
        createdAt: capture.capturedAt,
        completedAt: capture.capturedAt,
      } satisfies PromptRun,
    ];
  });
