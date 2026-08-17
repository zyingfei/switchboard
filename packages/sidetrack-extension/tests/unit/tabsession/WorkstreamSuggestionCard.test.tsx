import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SuggestionCandidateSummary } from '../../../src/companion/categoryFlexibilityClient';
import { WorkstreamSuggestionCard } from '../../../src/sidepanel/tabsession/WorkstreamSuggestionCard';

const splitCandidate = (over: Partial<SuggestionCandidateSummary> = {}): SuggestionCandidateSummary => ({
  kind: 'split',
  scopeId: 'ws-1',
  fingerprint: 'a b c',
  memberIds: ['a', 'b', 'c'],
  memberCount: 3,
  suggestedName: 'kv-cache recsys',
  updatedAt: 1000,
  ...over,
});

const newCategoryCandidate = (
  over: Partial<SuggestionCandidateSummary> = {},
): SuggestionCandidateSummary => ({
  kind: 'new-category',
  scopeId: '__unfiled__',
  fingerprint: 'x y',
  memberIds: ['x', 'y'],
  memberCount: 2,
  suggestedName: 'weekend reading',
  updatedAt: 2000,
  ...over,
});

describe('WorkstreamSuggestionCard', () => {
  it('renders the split lead copy and the suggested name as a secondary line', () => {
    render(
      <WorkstreamSuggestionCard candidate={splitCandidate()} onAccept={vi.fn()} onDecline={vi.fn()} />,
    );
    expect(
      screen.getByText('These 3 pages look like their own group — split?'),
    ).toBeInTheDocument();
    expect(screen.getByText('kv-cache recsys')).toBeInTheDocument();
  });

  it('renders the new-category lead copy inline with the keywords', () => {
    render(
      <WorkstreamSuggestionCard
        candidate={newCategoryCandidate()}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(
      screen.getByText('These 2 unfiled pages look like a topic: weekend reading — create it?'),
    ).toBeInTheDocument();
  });

  it('falls back to a nameless lead when suggestedName is null', () => {
    render(
      <WorkstreamSuggestionCard
        candidate={newCategoryCandidate({ suggestedName: null })}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(
      screen.getByText('These 2 unfiled pages look like a topic — create it?'),
    ).toBeInTheDocument();
  });

  it('calls onAccept and onDecline', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    render(
      <WorkstreamSuggestionCard candidate={splitCandidate()} onAccept={onAccept} onDecline={onDecline} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalled();
  });

  it('disables both actions while pending', () => {
    render(
      <WorkstreamSuggestionCard
        candidate={splitCandidate()}
        pending
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
  });
});
