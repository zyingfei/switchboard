import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FocusView } from './FocusView';

describe('FocusView', () => {
  it('groups visits by topic cards', () => {
    render(
      <FocusView
        topics={[
          { id: 'topic:a', label: 'Alpha', memberCount: 2, cohesion: 0.91 },
          { id: 'topic:b', label: 'Beta', memberCount: 2, cohesion: 0.86 },
        ]}
        visitsByTopic={{}}
        engagementClassesByVisit={{}}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    expect(screen.getAllByTestId(/^focus-topic-/u)).toHaveLength(2);
  });

  it('shows engagement class dots for visits', () => {
    render(
      <FocusView
        topics={[{ id: 'topic:a', label: 'Alpha', memberCount: 2, cohesion: 0.91 }]}
        visitsByTopic={{
          'topic:a': [
            { id: 'visit:a', label: 'A', focusedWindowMs: 10_000 },
            { id: 'visit:b', label: 'B', focusedWindowMs: 5_000 },
          ],
        }}
        engagementClassesByVisit={{
          'visit:a': 'worked_on_reference',
          'visit:b': 'glanced',
        }}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId('focus-expand-topic:a'));
    expect(screen.getByTestId('engagement-dot-visit:a').className).toContain(
      'cx-engagement-worked_on_reference',
    );
    expect(screen.getByTestId('engagement-dot-visit:b').className).toContain(
      'cx-engagement-glanced',
    );
  });

  it('renders the workstream chip and click handlers', () => {
    const onTopicClick = vi.fn();
    const onVisitClick = vi.fn();
    render(
      <FocusView
        topics={[
          {
            id: 'topic:a',
            label: 'Alpha',
            memberCount: 1,
            cohesion: 0.91,
            dominantWorkstreamId: 'ws-a',
          },
        ]}
        visitsByTopic={{
          'topic:a': [{ id: 'visit:a', label: 'A', focusedWindowMs: 10_000 }],
        }}
        engagementClassesByVisit={{ 'visit:a': 'engaged_read' }}
        onTopicClick={onTopicClick}
        onVisitClick={onVisitClick}
      />,
    );

    expect(screen.getByText('Workstream')).toBeDefined();
    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByTestId('focus-expand-topic:a'));
    fireEvent.click(screen.getByTestId('focus-visit-visit:a'));
    expect(onTopicClick).toHaveBeenCalledWith('topic:a');
    expect(onVisitClick).toHaveBeenCalledWith('visit:a');
  });
});
