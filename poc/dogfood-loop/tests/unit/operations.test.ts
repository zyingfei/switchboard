import { describe, expect, it } from 'vitest';
import { createMemoryGraphStore } from '../../src/graph/memoryStore';
import {
  createConvergence,
  createForkForTargets,
  createPatchPreview,
  recordChatResponse,
} from '../../src/graph/operations';
import { buildUpdatedMarkdown } from '../../src/patch/markdownPatch';
import { buildDispatchPreflight } from '../../src/preflight/dispatchPreflight';

describe('workstream operations', () => {
  it('forks one source note to two prompt runs and two fork edges', async () => {
    const store = createMemoryGraphStore();

    await createForkForTargets(store, '# Brainstorm\nPlease review this product idea.\n', [
      {
        provider: 'mock-chat-a',
        title: 'Mock Chat A',
        targetUrl: 'chrome-extension://test/mock-chat.html?provider=mock-chat-a',
      },
      {
        provider: 'mock-chat-b',
        title: 'Mock Chat B',
        targetUrl: 'chrome-extension://test/mock-chat.html?provider=mock-chat-b',
      },
    ]);

    const nodes = await store.listNodes();
    const edges = await store.listEdges();
    const runs = await store.listPromptRuns();

    expect(nodes.filter((node) => node.type === 'note')).toHaveLength(1);
    expect(runs).toHaveLength(2);
    expect(edges.filter((edge) => edge.type === 'forked_to')).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(['queued', 'queued']);
  });

  it('creates a convergence node from recorded responses', async () => {
    const store = createMemoryGraphStore();
    const fork = await createForkForTargets(store, '# Brainstorm\n', [
      {
        provider: 'mock-chat-a',
        title: 'Mock Chat A',
        targetUrl: 'chrome-extension://test/mock-chat.html?provider=mock-chat-a',
      },
    ]);

    await recordChatResponse(
      store,
      fork.promptRuns[0]?.id ?? '',
      'mock-chat-a',
      'Mock Chat A response',
      'A says verify the loop.',
    );

    const convergence = await createConvergence(store, 'useA');

    expect(convergence.type).toBe('convergence');
    expect(convergence.content).toContain('A says verify the loop.');
    expect((await store.listEdges()).some((edge) => edge.type === 'converged_into')).toBe(true);
  });

  it('creates a patch preview and deterministic markdown output', async () => {
    const store = createMemoryGraphStore();
    const fork = await createForkForTargets(store, '# Brainstorm\n', [
      {
        provider: 'mock-chat-b',
        title: 'Mock Chat B',
        targetUrl: 'chrome-extension://test/mock-chat.html?provider=mock-chat-b',
      },
      {
        provider: 'mock-chat-a',
        title: 'Mock Chat A',
        targetUrl: 'chrome-extension://test/mock-chat.html?provider=mock-chat-a',
      },
    ]);
    await recordChatResponse(store, fork.promptRuns[0]?.id ?? '', 'mock-chat-b', 'Mock Chat B', 'B output.');
    await recordChatResponse(store, fork.promptRuns[1]?.id ?? '', 'mock-chat-a', 'Mock Chat A', 'A output.');

    const patch = await createPatchPreview(store, 'appendBoth');
    const expected = buildUpdatedMarkdown(
      '# Brainstorm\n',
      [
        { provider: 'mock-chat-b', title: 'Mock Chat B', content: 'B output.' },
        { provider: 'mock-chat-a', title: 'Mock Chat A', content: 'A output.' },
      ],
      'appendBoth',
    );

    expect(patch.type).toBe('patch');
    expect(JSON.parse(patch.content ?? '{}')).toMatchObject({ proposed: expected });
    expect(expected).toBe('# Brainstorm\n\n## Converged Responses\n\n### Mock Chat A\n\nA output.\n\n### Mock Chat B\n\nB output.\n');
  });

  it('catches obvious redaction and dispatch preflight risks', () => {
    const preflight = buildDispatchPreflight({
      targetProvider: 'mock-chat-a',
      targetUrl: 'chrome-extension://test/mock-chat.html',
      promptText: 'Email jane@example.com and use sk-abc1234567890abcdef at http://192.168.1.4/wiki',
      autoSend: true,
    });

    expect(preflight.warnings).toEqual([
      'contains possible API key pattern',
      'contains email',
      'contains internal/private URL',
    ]);
  });
});
