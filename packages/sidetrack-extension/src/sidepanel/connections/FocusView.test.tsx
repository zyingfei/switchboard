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

    expect(screen.getAllByTestId(/^focus-topic-topic:/u)).toHaveLength(2);
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

    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getByTestId('engagement-dot-visit:a').className).toContain(
      'cx-engagement-worked_on_reference',
    );
    expect(screen.getByTestId('engagement-dot-visit:b').className).toContain(
      'cx-engagement-glanced',
    );
  });

  it('sorts visits by attention first, then recent activity', () => {
    render(
      <FocusView
        topics={[{ id: 'topic:a', label: 'Alpha', memberCount: 3, cohesion: 0.91 }]}
        visitsByTopic={{
          'topic:a': [
            {
              id: 'visit:old-read',
              label: 'Old read',
              lastSeenAt: '2026-05-14T08:00:00.000Z',
              focusedWindowMs: 10_000,
            },
            {
              id: 'visit:recent-glance',
              label: 'Recent glance',
              lastSeenAt: '2026-05-14T12:00:00.000Z',
              focusedWindowMs: 30_000,
            },
            {
              id: 'visit:recent-read',
              label: 'Recent read',
              lastSeenAt: '2026-05-14T12:30:00.000Z',
              focusedWindowMs: 5_000,
            },
          ],
        }}
        engagementClassesByVisit={{
          'visit:old-read': 'engaged_read',
          'visit:recent-glance': 'glanced',
          'visit:recent-read': 'engaged_read',
        }}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getAllByTestId(/^focus-visit-visit:/u).map((row) => row.textContent)).toEqual([
      expect.stringContaining('Recent read'),
      expect.stringContaining('Old read'),
      expect.stringContaining('Recent glance'),
    ]);
  });

  it('renders the workstream chip and click handlers', () => {
    const onTopicAnchor = vi.fn();
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
          'topic:a': [
            {
              id: 'visit:a',
              label: 'A',
              url: 'https://example.test/a',
              focusedWindowMs: 10_000,
            },
          ],
        }}
        engagementClassesByVisit={{ 'visit:a': 'engaged_read' }}
        onTopicClick={() => undefined}
        onTopicAnchor={onTopicAnchor}
        onEngagementRelabel={() => undefined}
        onVisitClick={onVisitClick}
      />,
    );

    expect(screen.getByText('Workstream signal')).toBeDefined();
    fireEvent.click(screen.getByTestId('focus-topic-anchor-topic:a'));
    expect(onTopicAnchor).toHaveBeenCalledWith({ topicId: 'topic:a', label: 'Alpha' });
    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getByTestId('focus-detail-topic:a')).toBeDefined();
    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getByTestId('focus-visit-open-visit:a').getAttribute('href')).toBe(
      'https://example.test/a',
    );
    fireEvent.click(screen.getByTestId('focus-visit-visit:a'));
    expect(onVisitClick).toHaveBeenCalledWith('visit:a');
    expect(screen.queryByTestId('focus-visit-anchor-visit:a')).toBeNull();
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

  it('marks oversized suggestions for triage and keeps save-name inside details', () => {
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
    expect(screen.queryByText('Save name')).toBeNull();
    fireEvent.click(screen.getByText('Large computed group'));
    expect(screen.getAllByText('Save name').length).toBeGreaterThan(0);
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

    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByTestId('focus-visit-label-visit:a'));
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
          ],
        }}
        engagementClassesByVisit={{}}
        workstreamOptions={[{ id: 'workstream:research', label: 'Research' }]}
        onTopicPromote={onTopicPromote}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Alpha'));
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

  it('renames a suggestion optimistically', async () => {
    const onTopicRename = vi.fn(() => Promise.resolve());
    render(
      <FocusView
        topics={[{ id: 'topic:a', label: 'Alpha', memberCount: 1, cohesion: 0.91 }]}
        visitsByTopic={{}}
        engagementClassesByVisit={{}}
        onTopicRename={onTopicRename}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.change(screen.getByTestId('focus-rename-input-topic:a'), {
      target: { value: 'Oracle research' },
    });
    fireEvent.click(screen.getByTestId('focus-rename-topic:a'));

    await waitFor(() => {
      expect(onTopicRename).toHaveBeenCalledWith({
        topicId: 'topic:a',
        previousName: 'Alpha',
        newName: 'Oracle research',
      });
    });
    expect(screen.getByText('Oracle research')).toBeDefined();
  });

  it('removes a visit from the visible suggestion and can restore it', async () => {
    const onVisitMarkNotRelated = vi.fn(() => Promise.resolve());
    const onVisitRestoreToTopic = vi.fn(() => Promise.resolve());
    render(
      <FocusView
        topics={[{ id: 'topic:a', label: 'Alpha', memberCount: 2, cohesion: 0.91 }]}
        visitsByTopic={{
          'topic:a': [
            { id: 'timeline-visit:https://example.test/a', label: 'A', focusedWindowMs: 10_000 },
            { id: 'timeline-visit:https://example.test/b', label: 'B', focusedWindowMs: 5_000 },
          ],
        }}
        engagementClassesByVisit={{}}
        onVisitMarkNotRelated={onVisitMarkNotRelated}
        onVisitRestoreToTopic={onVisitRestoreToTopic}
        onTopicClick={() => undefined}
        onVisitClick={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Alpha'));
    expect(screen.getAllByText('Remove')).toHaveLength(2);
    fireEvent.click(
      screen.getByTestId('focus-visit-not-related-topic:a-timeline-visit:https://example.test/b'),
    );

    await waitFor(() => {
      expect(onVisitMarkNotRelated).toHaveBeenCalledWith({
        topicId: 'topic:a',
        visitId: 'timeline-visit:https://example.test/b',
        memberVisitIds: [
          'timeline-visit:https://example.test/a',
          'timeline-visit:https://example.test/b',
        ],
      });
    });
    expect(screen.queryByTestId('focus-visit-timeline-visit:https://example.test/b')).toBeNull();
    fireEvent.click(screen.getByText('Undo'));
    await waitFor(() => {
      expect(onVisitRestoreToTopic).toHaveBeenCalledWith({
        topicId: 'topic:a',
        visitId: 'timeline-visit:https://example.test/b',
      });
    });
    expect(screen.getByTestId('focus-visit-timeline-visit:https://example.test/b')).toBeDefined();
  });
});
