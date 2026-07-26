import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NeedsOrganizeSuggestionRow } from '../../entrypoints/sidepanel/App';
import {
  PENDING_DEADLINE_MS,
  THREAD_SUGGESTION_RETRY_WINDOW_MS,
} from '../../src/sidepanel/tabsession/resolveOutcome';

// The self-heal contract for the Chat → Threads "Needs organize" card.
// Before this fix the row fetched GET /v1/suggestions/thread/{id} once and had
// NO error state and NO retry loop: a hung/failed fetch cleared the in-flight
// flag and rendered "Pick a workstream…" as if the resolver abstained, with
// nothing ever re-asking — a card stayed stuck for 10+ minutes while the
// endpoint answered 200 in ~2.4s. These tests exercise the row against a mocked
// companion + fake timers to prove: (a) a hanging fetch flips to busy at the
// pending deadline, (b) the visible card re-fetches on cadence after the busy
// flip and HEALS on the next successful probe.

const rowProps = (overrides: Record<string, unknown> = {}) => ({
  threadId: '6a666809-thread',
  companionPort: 17_373,
  bridgeKey: 'bridge-test-key',
  workstreamFingerprint: 'fp-1',
  indexRebuilding: false,
  resolveLabel: (id: string) => `label:${id}`,
  onCache: vi.fn(),
  onClearCache: vi.fn(),
  onAccept: vi.fn(),
  onPickManual: vi.fn(),
  onDismiss: vi.fn(),
  onStartWorkstream: vi.fn(async () => undefined),
  selfNominationDismissed: false,
  onDismissSelfNomination: vi.fn(),
  ...overrides,
});

const okSuggestion = (workstreamId: string, score: number, margin: number) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ workstreamId, score, breakdown: { margin } }] }),
});

const okEmpty = () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NeedsOrganizeSuggestionRow — thread busy flip + retry-on-cadence self-heal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('a hanging thread fetch flips to the busy card at the pending deadline', async () => {
    // A fetch that never resolves (served late as a slow 200/304 during a
    // drain) — the transport-error path never trips, so the deadline flip is
    // the only thing that rescues the card.
    const fetchMock = vi.fn(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<NeedsOrganizeSuggestionRow {...rowProps()} />);

    // Before the deadline: still pending, NOT busy.
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();

    // Past the 20s deadline the row synthesizes the busy state.
    await vi.advanceTimersByTimeAsync(PENDING_DEADLINE_MS + 500);
    await waitFor(() => {
      expect(screen.getByText('Companion is busy — retrying')).toBeInTheDocument();
    });
  });

  it('re-fetches on cadence after a busy flip and HEALS on the next successful probe', async () => {
    // First fetch FAILS (500 "database is locked" during a drain) → busy flip.
    // A later probe SUCCEEDS with a confident pick → the busy card heals.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
      return okSuggestion('ws-42', 0.85, 0.5);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<NeedsOrganizeSuggestionRow {...rowProps()} />);

    // The 500 lands → honest busy card (never the confident "pick a workstream").
    await waitFor(() => {
      expect(screen.getByText('Companion is busy — retrying')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The retry loop re-fetches on cadence (≤5s) — the KEY defect fix: the
    // stuck card asks again instead of hanging for 10 minutes.
    await vi.advanceTimersByTimeAsync(5_500);
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    // Late success supersedes the busy card: the pick renders, busy copy gone.
    await waitFor(() => {
      expect(screen.getByText('label:ws-42')).toBeInTheDocument();
    });
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();
    expect(screen.getByText('Highly likely')).toBeInTheDocument();
  });

  it('a healthy card that resolves does NOT keep polling (no runaway)', async () => {
    // A brand-new thread the resolver abstains on: one fetch, empty result,
    // then quiet — the retry loop only runs while busy.
    const fetchMock = vi.fn(async () => okEmpty());
    vi.stubGlobal('fetch', fetchMock);

    render(<NeedsOrganizeSuggestionRow {...rowProps()} />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // No busy state, so no retry loop: advancing past the whole retry window
    // must NOT issue further fetches.
    await vi.advanceTimersByTimeAsync(THREAD_SUGGESTION_RETRY_WINDOW_MS + 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();
  });
});
