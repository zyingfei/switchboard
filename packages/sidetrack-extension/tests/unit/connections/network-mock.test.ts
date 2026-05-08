import { createElement, Fragment } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fullFixture from '../../../src/sidepanel/connections/__fixtures__/context-pack-full.json';
import { ContextPackComposer } from '../../../src/sidepanel/connections/ContextPackComposer';
import { FlowPathView } from '../../../src/sidepanel/connections/FlowPathView';
import { FocusView } from '../../../src/sidepanel/connections/FocusView';
import type { ContextPackInput } from '../../../src/sidepanel/connections/contextPack';
import { WhyRelatedPanel } from '../../../src/sidepanel/connections/WhyRelatedPanel';

const isLlmUrl = (input: unknown): boolean => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
  return /ollama|openai|anthropic|claude\.ai|completions|api\.openai\.com|api\.anthropic\.com/iu.test(
    value,
  );
};

describe('connections network mock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Wave D surfaces without LLM-shaped fetch calls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (isLlmUrl(input)) throw new Error('LLM network call blocked');
      return Promise.resolve(new Response('{}'));
    });

    render(
      createElement(
        Fragment,
        null,
        createElement(FlowPathView, {
          visits: [
            {
              id: 'visit:a',
              label: 'A',
              commitTimestamp: '2026-05-08T10:00:00.000Z',
              tabSessionIdHash: 'tab-a',
            },
          ],
          navigationEdges: [],
          crossReplicaEdges: [],
          onNodeClick: () => undefined,
        }),
        createElement(FocusView, {
          topics: [{ id: 'topic:a', label: 'Topic', memberCount: 1, cohesion: 0.9 }],
          visitsByTopic: {},
          engagementClassesByVisit: {},
          onTopicClick: () => undefined,
          onVisitClick: () => undefined,
        }),
        createElement(WhyRelatedPanel, {
          fromVisitId: 'visit:a',
          reasons: [{ code: 'SAME_THREAD', threadId: 'thread:a', threadName: 'Thread A' }],
          showOnlyUserAsserted: false,
          onToggleAssertedOnly: () => undefined,
          onClose: () => undefined,
        }),
        createElement(ContextPackComposer, {
          workstreamId: 'workstream:a',
          loadInput: async () => fullFixture as ContextPackInput,
          onClose: () => undefined,
        }),
      ),
    );

    expect(screen.getByTestId('flow-path-view')).toBeDefined();
    expect(screen.getByTestId('focus-view')).toBeDefined();
    expect(screen.getByTestId('why-related-panel')).toBeDefined();
    expect(screen.getByTestId('context-pack-composer')).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
