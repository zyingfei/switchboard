import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App, { NeedsOrganizeSuggestionRow } from '../../entrypoints/sidepanel/App';
import type { WorkboardRequest } from '../../src/messages';
import { PENDING_DEADLINE_MS } from '../../src/sidepanel/tabsession/resolveOutcome';
import {
  createEmptyWorkboardState,
  defaultSettings,
  type WorkboardState,
} from '../../src/workboard';

// ---------------------------------------------------------------------------
// CLASS-FIX conformance net: "no fourth unhealed busy surface."
//
// Three surfaces in the panel render the honest amber busy/"retrying" state
// (via the shared resolveOutcome contract). Each was healed one at a time —
// the lesson of that repetition is that a NEW surface can render the same busy
// copy while silently forgetting the self-heal wiring. This file mounts EVERY
// busy-rendering surface against a HANGING-then-RECOVERING companion and
// asserts each one HEALS (busy flips at the pending deadline, then a late
// success supersedes it). If a fourth surface renders the busy copy without a
// retry loop, adding it to SURFACES below (or a sibling `it`) will fail here.
//
// The surfaces:
//   1. Current-tab "Now" card — REGULAR page (has pageEvidence). Healed in
//      feat/panel-pending-deadline.
//   2. Current-tab "Now" card — CHAT thread (NO pageEvidence, captured through
//      the dispatch path). THE THIRD surface: the retry loop's
//      `pageEvidence === undefined` guard shut it off, so the deadline flip
//      left a frozen busy card. Fixed by gating the loop on "there is a busy
//      error to heal", not on page evidence.
//   3. NeedsOrganizeSuggestionRow (Chat → Threads "Needs organize"). Healed in
//      fix/thread-busy-heal.
// ---------------------------------------------------------------------------

const NOW = '2026-04-26T21:40:00.000Z';
const SETUP_COMPLETED_KEY = 'sidetrack:setupCompleted';

type StorageQuery = string | readonly string[] | Record<string, unknown> | null | undefined;

const baseState = (): WorkboardState =>
  createEmptyWorkboardState({
    companionStatus: 'connected',
    settings: {
      ...defaultSettings,
      companion: { port: 17_373, bridgeKey: 'bridge-test-key' },
    },
    workstreams: [
      {
        bac_id: 'bac_workstream_sibling',
        revision: 'rev_workstream_sibling',
        title: 'Sibling',
        children: [],
        tags: [],
        checklist: [],
        privacy: 'shared',
        updatedAt: NOW,
      },
    ],
  });

const installChromeMock = (state: WorkboardState, activeTabUrl: string) => {
  const sendMessage = vi.fn((request: WorkboardRequest | { readonly type?: unknown }) =>
    Promise.resolve({ ok: true, state, request }),
  );
  const localValues: Record<string, unknown> = { [SETUP_COMPLETED_KEY]: true };
  const get = vi.fn((query: StorageQuery): Promise<Record<string, unknown>> => {
    if (typeof query === 'string') return Promise.resolve({ [query]: localValues[query] });
    if (Array.isArray(query)) {
      return Promise.resolve(Object.fromEntries(query.map((key) => [key, localValues[key]])));
    }
    if (query !== null && query !== undefined) {
      return Promise.resolve(
        Object.fromEntries(
          Object.entries(query).map(([key, fallback]) => [key, localValues[key] ?? fallback]),
        ),
      );
    }
    return Promise.resolve({ ...localValues });
  });
  const set = vi.fn((values: Record<string, unknown>): Promise<void> => {
    Object.assign(localValues, values);
    return Promise.resolve();
  });
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: { local: { get, set }, session: { get, set } },
    tabs: {
      query: vi.fn(() => Promise.resolve([{ url: activeTabUrl }])),
      update: vi.fn(() => Promise.resolve({ id: 42 })),
      create: vi.fn(() => Promise.resolve({ id: 99 })),
    },
    windows: { update: vi.fn(() => Promise.resolve({})) },
  });
  return sendMessage;
};

const goToNow = async (): Promise<void> => {
  const navBtn = await screen.findByTestId('section-nav-now');
  fireEvent.click(navBtn);
};

// A batch-resolve response carrying a confident pick for the focused URL.
const lateSuggestionFor = (canonicalUrl: string) => ({
  canonicalUrl,
  dryRun: true,
  decision: { action: 'suggest', workstreamId: 'bac_workstream_sibling', margin: 1.4 },
  fusedCandidates: [
    {
      workstreamId: 'bac_workstream_sibling',
      rawFusionLogit: 2.4,
      dominantSource: 'similarity',
      reasons: [],
    },
  ],
});

// Build the /v1/visits fetch mock for the Now card. `hasPageEvidence=false`
// models a chat thread (captured through the dispatch path — the page-text
// indexer never ran, so the summary route returns no evidence).
//
// Recovery is isolated to the RETRY LOOP: the FIRST batch-resolve HANGS forever
// (the true 304-after-200s shape — the original in-flight request never
// settles), so the ONLY way the card can heal is a FRESH probe issued by the
// self-heal loop. `probes` counts batch-resolve calls; the second+ call answers
// with the confident pick. Without a working retry loop (the chat freeze) the
// card stays busy indefinitely — there is no second probe.
// `settledEmpty` models the OTHER live failure shape (the GCP-thread freeze,
// round four): the companion ANSWERS quickly with zero candidates. A settled
// empty answer is a terminal state — the pending-deadline clock must stop, so
// the card stays the honest empty card and never flips to the synthetic busy.
const nowCardFetchMock = (
  canonicalUrl: string,
  hasPageEvidence: boolean,
  probes: { count: number },
  options?: { readonly settledEmpty?: boolean },
) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/tabsessions/projection')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { schemaVersion: 1, bySessionId: {}, openSessionsByTabId: {} } }),
      };
    }
    if (url.includes('/v1/visits/projection')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            schemaVersion: 1,
            byCanonicalUrl: {
              [canonicalUrl]: {
                canonicalUrl,
                firstSeenAt: NOW,
                lastSeenAt: NOW,
                visitCount: 3,
                tabSessionIds: ['tses_hang'],
                latestUrl: canonicalUrl,
                latestTitle: 'A conversation mid-drain',
                attributionHistory: [],
              },
            },
          },
        }),
      };
    }
    if (url.includes('/v1/tabsessions/inbox') || url.includes('/v1/visits/inbox')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
      };
    }
    if (url.includes('/v1/page-evidence/summary')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            canonicalUrl,
            pageEvidence: hasPageEvidence
              ? {
                  tier: 'content_features_only',
                  evidenceRevision: 'evidence-hang',
                  semanticFeatureRevision: 'semantic-hang',
                  updatedAt: NOW,
                  termCount: 40,
                  keyphraseCount: 20,
                  entityCount: 5,
                  quality: 'medium',
                }
              : null,
            stale: false,
          },
        }),
      };
    }
    if (url.includes('/v1/visits/batch-resolve')) {
      probes.count += 1;
      if (options?.settledEmpty === true) {
        // Every probe answers immediately with ZERO candidates — the honest
        // "the resolver checked and found nothing" response (live shape:
        // the GCP thread's resolve settles empty in ~1s).
        const rawEmptyBody = typeof init?.body === 'string' ? init.body : '{}';
        const emptyBody = JSON.parse(rawEmptyBody) as {
          readonly canonicalUrls?: readonly string[];
        };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              results: Object.fromEntries(
                (emptyBody.canonicalUrls ?? []).map((u) => [
                  u,
                  {
                    canonicalUrl: u,
                    dryRun: true,
                    decision: { action: 'inbox', margin: 0 },
                    fusedCandidates: [],
                  },
                ]),
              ),
            },
          }),
        };
      }
      // First probe hangs forever (never settles) — only a fresh retry-loop
      // probe can rescue the card.
      if (probes.count === 1) {
        await new Promise<void>(() => {
          /* never resolves */
        });
      }
      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(rawBody) as { readonly canonicalUrls?: readonly string[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            results: Object.fromEntries(
              (body.canonicalUrls ?? []).map((u) => [u, lateSuggestionFor(canonicalUrl)]),
            ),
          },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('busy-heal conformance — every busy surface flips at the deadline and heals on a late success', () => {
  // Drives the Now card end-to-end: pending → busy flip at the deadline →
  // healed once the held resolve is released. Parameterised on page evidence so
  // the SAME assertions cover the regular-page path (regression) and the chat
  // path (the fix). If either fails to heal, the retry loop is missing for that
  // kind — exactly the "unhealed surface" this net exists to catch.
  // `assertBusyFlip` — for a surface whose retry loop only starts AFTER the
  // pending-deadline busy flip (the chat card: no pageEvidence, so the loop is
  // gated on the busy error). We observe the full pending → busy → healed
  // sequence, which is the exact frozen-then-fixed path. A surface whose retry
  // loop runs BEFORE the deadline (the regular page: pageEvidence present) may
  // heal via a fresh probe without ever visibly flipping to busy — that is
  // still healthy, so we only assert the terminal healed state there.
  const runNowCardHeal = async (
    canonicalUrl: string,
    hasPageEvidence: boolean,
    assertBusyFlip: boolean,
  ): Promise<void> => {
    installChromeMock({ ...baseState(), activeTabUrl: canonicalUrl }, canonicalUrl);
    const probes = { count: 0 };
    vi.stubGlobal('fetch', nowCardFetchMock(canonicalUrl, hasPageEvidence, probes));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await goToNow();
    const card = await screen.findByLabelText('Current tab attribution');

    if (assertBusyFlip) {
      // Pending (the first resolve hangs forever), NOT yet busy.
      await waitFor(() => {
        expect(card).toHaveTextContent('Checking connections…');
      });
      expect(card).not.toHaveTextContent('Companion is busy — retrying');
      // Past the deadline: the still-pending card flips to the amber busy state.
      await vi.advanceTimersByTimeAsync(PENDING_DEADLINE_MS + 500);
      await waitFor(() => {
        expect(card).toHaveTextContent('Companion is busy — retrying');
      });
    }

    // The self-heal RETRY LOOP is the only path that can recover the card (the
    // original resolve never settles). Advance the retry window: a FRESH probe
    // succeeds, clears the busy error, and the confident pick supersedes. For a
    // chat thread (no pageEvidence) this ONLY works because the retry loop no
    // longer requires pageEvidence; without the fix the loop never runs and the
    // card stays frozen busy forever.
    await vi.advanceTimersByTimeAsync(PENDING_DEADLINE_MS + 10_000);
    await waitFor(() => {
      expect(card).toHaveTextContent('Sibling');
    });
    expect(card).not.toHaveTextContent('Companion is busy — retrying');
    // Prove recovery came from a SECOND probe (a self-heal retry), not the
    // original hung request finally settling.
    expect(probes.count).toBeGreaterThan(1);
  };

  it('current-tab Now card — regular page (has page evidence) heals', async () => {
    await runNowCardHeal('https://news.ycombinator.com/item?id=48300001', true, false);
  });

  it('current-tab Now card — CHAT thread (no page evidence) flips busy then heals [the third surface]', async () => {
    // chatgpt.com host → classifyPageKind returns 'chat'; the summary route
    // returns pageEvidence: null (chat captured via dispatch, not page-text).
    await runNowCardHeal('https://chatgpt.com/c/6a666809-aaaa-bbbb-cccc-dddddddddddd', false, true);
  });

  it('current-tab Now card — a resolve that SETTLES EMPTY stays the honest empty card, never flips busy [the fourth face]', async () => {
    // The GCP-thread live failure (round four of the frozen-card saga): the
    // companion answered "no candidates" in ~1s, but the pending clock treated
    // settled-empty as still-pending (`hasResult` required length > 0) →
    // synthetic busy at 20s → heal → clock restart → re-flip → frozen busy
    // once the 30s retry window closed. The contract under test: an ANSWER —
    // even an empty one — stops the deadline clock for good.
    const canonicalUrl = 'https://chatgpt.com/c/6a666809-eeee-ffff-0000-111111111111';
    installChromeMock({ ...baseState(), activeTabUrl: canonicalUrl }, canonicalUrl);
    const probes = { count: 0 };
    vi.stubGlobal('fetch', nowCardFetchMock(canonicalUrl, false, probes, { settledEmpty: true }));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await goToNow();
    const card = await screen.findByLabelText('Current tab attribution');

    // The companion ANSWERED (empty) — the honest empty card renders.
    await waitFor(() => {
      expect(card).toHaveTextContent('No connections yet');
    });
    expect(card).not.toHaveTextContent('Companion is busy — retrying');

    // Continuous 1s-step scan well past the deadline AND the retry window.
    // Traced on the broken build (settled-empty treated as still-pending):
    // the card is NOT frozen at one instant — it OSCILLATES on a 30s period
    // (busy flip at each 20s deadline → heal probe clears it → clock
    // restarts), flashing the amber busy card and issuing a fresh
    // batch-resolve every cycle, forever. Coarse spot-checks slip between
    // the flashes, so scan every simulated second and assert busy NEVER
    // renders at any step.
    for (let elapsedS = 0; elapsedS < 150; elapsedS += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(card).not.toHaveTextContent('Companion is busy — retrying');
    }
    // Terminal state is still the honest empty card…
    expect(card).toHaveTextContent('No connections yet');
    // …and the settled answer also SILENCED the probe loop: exactly the one
    // initial batch-resolve, no 30s re-probe churn against the companion
    // (the oscillation's hidden runtime cost).
    expect(probes.count).toBe(1);
  });

  it('NeedsOrganizeSuggestionRow (Chat → Threads "Needs organize") heals', async () => {
    // First probe 500s (busy flip); the next probe succeeds and the card heals.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ workstreamId: 'ws-42', score: 0.85, breakdown: { margin: 0.5 } }] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <NeedsOrganizeSuggestionRow
        threadId="6a666809-thread"
        companionPort={17_373}
        bridgeKey="bridge-test-key"
        workstreamFingerprint="fp-1"
        indexRebuilding={false}
        resolveLabel={(id: string) => `label:${id}`}
        onCache={vi.fn()}
        onClearCache={vi.fn()}
        onAccept={vi.fn()}
        onPickManual={vi.fn()}
        onDismiss={vi.fn()}
        onStartWorkstream={vi.fn(async () => undefined)}
        selfNominationDismissed={false}
        onDismissSelfNomination={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Companion is busy — retrying')).toBeInTheDocument();
    });
    // The retry loop re-fetches on cadence and heals on the next success.
    await vi.advanceTimersByTimeAsync(5_500);
    await waitFor(() => {
      expect(screen.getByText('label:ws-42')).toBeInTheDocument();
    });
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();
  });
});
