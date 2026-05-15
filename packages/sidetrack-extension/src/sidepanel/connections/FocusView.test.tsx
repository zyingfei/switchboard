import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getAllByText('Suggestion')).toHaveLength(2);
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

  it('renders secondary affiliations as also-related visits', () => {
    render(
      <FocusView
        topics={[
          {
            id: 'topic:a',
            label: 'Alpha',
            memberCount: 2,
            secondaryCount: 1,
            cohesion: 0.91,
          },
        ]}
        visitsByTopic={{
          'topic:a': [
            { id: 'visit:a', label: 'Primary', focusedWindowMs: 10_000 },
            {
              id: 'visit:b',
              label: 'Secondary',
              focusedWindowMs: 4_000,
              affiliation: 'secondary',
              secondaryScore: 0.78,
              secondaryReasons: ['edge_support', 'member_similarity'],
            },
          ],
        }}
        engagementClassesByVisit={{}}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    expect(screen.getByText('2 pages · 1 also related')).toBeDefined();
    fireEvent.click(screen.getByTestId('focus-expand-topic:a'));
    expect(screen.getByText('Also related 0.78')).toBeDefined();
    expect(screen.getByTitle('score 0.78 · edge_support, member_similarity')).toBeDefined();
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

    expect(screen.getByText('Workstream signal')).toBeDefined();
    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByTestId('focus-expand-topic:a'));
    fireEvent.click(screen.getByTestId('focus-visit-visit:a'));
    expect(onTopicClick).toHaveBeenCalledWith('topic:a');
    expect(onVisitClick).toHaveBeenCalledWith('visit:a');
  });

  it('hides collapsed computed groups behind a triage guard', () => {
    const onTopicClick = vi.fn();
    render(
      <FocusView
        topics={[{ id: 'topic:giant', label: 'Hacker News', memberCount: 272, cohesion: 0.62 }]}
        visitsByTopic={{}}
        engagementClassesByVisit={{}}
        onTopicClick={onTopicClick}
        onVisitClick={() => undefined}
      />,
    );

    expect(screen.getByTestId('focus-collapse-guard')).toBeDefined();
    expect(screen.getByText('Needs triage')).toBeDefined();
    expect(screen.queryByTestId('focus-topic-topic:giant')).toBeNull();

    fireEvent.click(screen.getByTestId('focus-triage-inspect-topic:giant'));
    expect(onTopicClick).toHaveBeenCalledWith('topic:giant');
  });

  it('hides two-topic sudden collapse when previous topic count was high', () => {
    render(
      <FocusView
        topics={[
          { id: 'topic:a', label: 'Alpha', memberCount: 10, cohesion: 0.8 },
          { id: 'topic:b', label: 'Beta', memberCount: 9, cohesion: 0.8 },
        ]}
        previousTopicCount={6}
        visitsByTopic={{}}
        engagementClassesByVisit={{}}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    expect(screen.getByTestId('focus-collapse-guard')).toBeDefined();
    expect(screen.queryByTestId('focus-topic-topic:a')).toBeNull();
  });

  it('renders an explicit empty state when scoped focus has no suggestion', () => {
    render(
      <FocusView
        topics={[]}
        visitsByTopic={{}}
        engagementClassesByVisit={{}}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    expect(screen.getByTestId('focus-empty')).toBeDefined();
    expect(screen.getByText('No scoped focus group')).toBeDefined();
  });

  it('marks oversized suggestions for triage without enabling computed-topic rename', () => {
    render(
      <FocusView
        topics={[
          { id: 'topic:large', label: 'Large computed group', memberCount: 41, cohesion: 0.71 },
          { id: 'topic:small', label: 'Small computed group', memberCount: 2, cohesion: 0.89 },
        ]}
        eligibleVisitCount={100}
        visitsByTopic={{}}
        engagementClassesByVisit={{}}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    expect(screen.getByTestId('focus-topic-topic:large')).toBeDefined();
    expect(screen.getByText('Needs triage')).toBeDefined();
    expect(screen.queryByText('Rename')).toBeNull();
  });

  it('fires per-visit engagement relabel feedback', async () => {
    const onEngagementRelabel = vi.fn(() => Promise.resolve());
    render(
      <FocusView
        topics={[{ id: 'topic:a', label: 'Alpha', memberCount: 1, cohesion: 0.91 }]}
        visitsByTopic={{
          'topic:a': [{ id: 'visit:a', label: 'A', focusedWindowMs: 10_000 }],
        }}
        engagementClassesByVisit={{ 'visit:a': 'skimmed' }}
        onEngagementRelabel={onEngagementRelabel}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId('focus-expand-topic:a'));
    fireEvent.change(screen.getByTestId('focus-visit-engagement-visit:a'), {
      target: { value: 'worked_on_reference' },
    });

    await waitFor(() => {
      expect(onEngagementRelabel).toHaveBeenCalledWith({
        visitId: 'visit:a',
        fromClass: 'skimmed',
        toClass: 'worked_on_reference',
      });
    });
  });

  it('promotes a computed suggestion to a workstream with frozen members', async () => {
    const onTopicPromote = vi.fn(() => Promise.resolve());
    render(
      <FocusView
        topics={[{ id: 'topic:a', label: 'Alpha', memberCount: 2, cohesion: 0.91 }]}
        visitsByTopic={{
          'topic:a': [
            { id: 'timeline-visit:https://example.test/a', label: 'A', focusedWindowMs: 10_000 },
            { id: 'timeline-visit:https://example.test/b', label: 'B', focusedWindowMs: 5_000 },
            {
              id: 'timeline-visit:https://example.test/candidate',
              label: 'Candidate',
              focusedWindowMs: 2_000,
              affiliation: 'secondary',
              secondaryScore: 0.74,
            },
          ],
        }}
        engagementClassesByVisit={{}}
        workstreamOptions={[{ id: 'workstream:research', label: 'Research' }]}
        onTopicPromote={onTopicPromote}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId('focus-promote-topic:a'));

    await waitFor(() => {
      expect(onTopicPromote).toHaveBeenCalledWith({
        topicId: 'topic:a',
        targetWorkstreamId: 'workstream:research',
        memberVisitIds: [
          'timeline-visit:https://example.test/a',
          'timeline-visit:https://example.test/b',
        ],
      });
    });
  });
});
