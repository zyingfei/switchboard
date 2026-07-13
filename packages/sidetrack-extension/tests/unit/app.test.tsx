import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App, {
  companionGetInFlightKey,
  formatBuildTimestamp,
} from '../../entrypoints/sidepanel/App';
import { messageTypes, type WorkboardRequest } from '../../src/messages';
import type { NoCaptureRule } from '../../src/capture/noCaptureRules';
import {
  createEmptyWorkboardState,
  defaultSettings,
  type WorkboardState,
} from '../../src/workboard';

const NOW = '2026-04-26T21:40:00.000Z';
const SETUP_COMPLETED_KEY = 'sidetrack:setupCompleted';

type StorageQuery = string | readonly string[] | Record<string, unknown> | null | undefined;

const liveState = (): WorkboardState =>
  createEmptyWorkboardState({
    companionStatus: 'disconnected',
    queuedCaptureCount: 2,
    settings: {
      ...defaultSettings,
      companion: { port: 17_373, bridgeKey: 'bridge-test-key' },
    },
    selectorHealth: [
      {
        provider: 'chatgpt',
        latestStatus: 'warning',
        latestCheckedAt: NOW,
        warning: 'ChatGPT extractor health: fallback active',
      },
    ],
    workstreams: [
      {
        bac_id: 'bac_workstream_root',
        revision: 'rev_workstream_root',
        title: 'Sidetrack',
        children: [],
        tags: ['architecture'],
        checklist: [
          {
            id: 'check_1',
            text: 'Review M1 wiring',
            checked: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        privacy: 'private',
        updatedAt: NOW,
      },
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
    threads: [
      {
        bac_id: 'bac_thread_test',
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/thread',
        title: 'Side-panel state machine review',
        lastSeenAt: NOW,
        status: 'active',
        trackingMode: 'auto',
        primaryWorkstreamId: 'bac_workstream_root',
        tags: [],
        tabSnapshot: {
          tabId: 42,
          windowId: 7,
          url: 'https://claude.ai/chat/thread',
          title: 'Side-panel state machine review',
          capturedAt: NOW,
        },
      },
    ],
    queueItems: [
      {
        bac_id: 'bac_queue_test',
        text: 'Ask Claude to compare with VM live migration architecture.',
        scope: 'workstream',
        targetId: 'bac_workstream_root',
        status: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    reminders: [
      {
        bac_id: 'bac_reminder_test',
        revision: 'rev_reminder_test',
        threadId: 'bac_thread_test',
        provider: 'claude',
        detectedAt: NOW,
        status: 'new',
      },
    ],
  });

const installChromeMock = (
  state: WorkboardState,
  storageValues: Record<string, unknown> = {},
  activeTabUrl?: string,
) => {
  const sendMessage = vi.fn((request: WorkboardRequest | { readonly type?: unknown }) =>
    Promise.resolve({
      ok: true,
      state,
      request,
    }),
  );
  const localValues: Record<string, unknown> = { ...storageValues };
  const get = vi.fn((query: StorageQuery): Promise<Record<string, unknown>> => {
    if (typeof query === 'string') {
      return Promise.resolve({ [query]: localValues[query] });
    }
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
      query: vi.fn(() =>
        Promise.resolve(activeTabUrl === undefined ? [] : [{ url: activeTabUrl }]),
      ),
      // openTabForThread (Open action) may focus/create a tab; stub so
      // the async path resolves instead of throwing an unhandled
      // rejection during the read-semantics tests.
      update: vi.fn(() => Promise.resolve({ id: 42 })),
      create: vi.fn(() => Promise.resolve({ id: 99 })),
    },
    windows: {
      update: vi.fn(() => Promise.resolve({})),
    },
  });
  return sendMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// Navigate to an old flat-tab destination through the redesigned chrome
// (lamp → primary section nav → contextual sub-tab). The flat 7-tab bar
// was retired: each section now reveals only its own sub-tabs, so a
// destination is reached by first selecting its owning section, then the
// sub-tab. Every sub-tab keeps its exact role=tab accessible name, so
// callers still assert against `getByRole('tab', { name })` after this.
//   Now             → Now section (single surface, no sub-tab)
//   Threads/Workstreams/Queued follow-ups → Work section
//   Search/Explore  → Library section (formerly Memory)
//   Inbound replies/Inbox → Inbox section (the merged incoming-things
//                           home; Trust was split three ways in R1.2)
const SECTION_OF_TAB: Record<string, string> = {
  Now: 'now',
  Threads: 'work',
  Workstreams: 'work',
  'Queued follow-ups': 'work',
  Search: 'library',
  Explore: 'library',
  'Inbound replies': 'inbox',
  Inbox: 'inbox',
};
const goToTab = async (name: string): Promise<void> => {
  const section = SECTION_OF_TAB[name];
  if (section !== undefined) {
    const navBtn = await screen.findByTestId(`section-nav-${section}`);
    fireEvent.click(navBtn);
  }
  if (name === 'Now') return;
  fireEvent.click(await screen.findByRole('tab', { name }));
};

describe('live side-panel App wiring', () => {
  it('keys in-flight companion GETs by bridge key as well as port and path', () => {
    const oldKey = companionGetInFlightKey('17373', 'old-bridge-key', '/v1/visits/projection');
    const rotatedKey = companionGetInFlightKey('17373', 'new-bridge-key', '/v1/visits/projection');
    const inFlight = new Map<string, Promise<unknown>>([[oldKey, Promise.resolve('old')]]);

    expect(rotatedKey).toBe('17373\0new-bridge-key\0/v1/visits/projection');
    expect(rotatedKey).not.toBe(oldKey);
    expect(inFlight.has(rotatedKey)).toBe(false);
  });

  it('formats build timestamps with date and UTC time', () => {
    expect(formatBuildTimestamp('2026-05-03T20:16:57.395Z')).toBe('2026-05-03 20:16Z');
  });

  it('renders Wizard on first launch when setup is incomplete and bridge key is empty', async () => {
    installChromeMock(createEmptyWorkboardState());

    render(<App />);

    expect(await screen.findByText('Set up Sidetrack')).toBeInTheDocument();
    expect(screen.getByText('Use Sidetrack without vault sync →')).toBeInTheDocument();
  });

  it('renders Workboard when setupCompleted flag is true', async () => {
    const sendMessage = installChromeMock(createEmptyWorkboardState(), {
      [SETUP_COMPLETED_KEY]: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: messageTypes.getWorkboardState });
    });
    expect(screen.queryByText('Set up Sidetrack')).not.toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toBeInTheDocument();
  });

  it('renders the spec-aligned side panel scaffolding', async () => {
    const sendMessage = installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });

    render(<App />);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: messageTypes.getWorkboardState });
    });
    expect(screen.queryByText('Set up Sidetrack')).not.toBeInTheDocument();
    // Scope D — default view is Now; the workstream scaffolding
    // (Open threads / Captures / ws-bar) lives under Workstreams now.
    await goToTab('Workstreams');
    expect(await screen.findByText('Open threads')).toBeInTheDocument();
    expect(screen.getByText('Captures')).toBeInTheDocument();
    // ws-bar shows the current workstream label (default: "not set")
    expect(screen.getByRole('button', { name: /not set/ })).toBeInTheDocument();
  });

  // FU3b — "searches indexed threads through the recall proxy" +
  // "shows thread search errors from the recall proxy" tests deleted.
  // The legacy threadSearchPanel form they exercised was removed
  // along with messageTypes.recallQuery (search now flows through
  // the top-level Search tab + useRecallSearch + /v2/recall, which
  // has its own unit coverage in tests/unit/connections/useRecallSearch.test.ts).

  it('does not show "companion disconnected" banner in local-only mode', async () => {
    installChromeMock(createEmptyWorkboardState({ companionStatus: 'local-only' }), {
      [SETUP_COMPLETED_KEY]: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Companion: disconnected/)).not.toBeInTheDocument();
  });

  it('Send to dropdown → Claude opens DispatchConfirm with side-effect header', async () => {
    // Smoke test for the new one-tap dispatch path. We need
    // companion-connected state so the dropdown isn't disabled.
    const state = liveState();
    installChromeMock(
      {
        ...state,
        companionStatus: 'connected',
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);

    // The default view is "Workstream: not set" (Inbox); the test
    // thread lives in a Sidetrack workstream marked private. Switch
    // to "All threads" which shows every thread regardless of
    // workstream so we can drive the row directly. The thread title
    // renders masked as `[private]` because the workstream is
    // private — find by that, not by the actual title string.
    await screen.findByRole('main', { name: 'Sidetrack workboard' });
    await goToTab('Threads');

    // Wait for the thread bucket to render under the Threads tab.
    const threadRow = (await screen.findByText('[private]')).closest('.thread');
    expect(threadRow).not.toBeNull();
    if (threadRow !== null) {
      fireEvent.mouseEnter(threadRow);
    }

    // Click the Send-to action (icon-only button; matched by aria-label).
    const sendToBtn = await screen.findByRole('button', { name: /Send to another AI/i });
    fireEvent.click(sendToBtn);

    // Dropdown opens with sectioned options.
    expect(await screen.findByText('Ask another AI')).toBeInTheDocument();
    expect(screen.getByText('Hand to coding agent')).toBeInTheDocument();
    expect(screen.getByText('Export as file')).toBeInTheDocument();

    // Pick Claude — packet composes silently and DispatchConfirm
    // mounts with the side-effect header. Use getAllByRole because
    // "Claude" appears in multiple dropdown sections / chips.
    const claudeButtons = screen.getAllByRole('button', { name: 'Claude' });
    // First match in the dropdown is the AI provider row.
    const [claudeButton] = claudeButtons;
    fireEvent.click(claudeButton);

    // DispatchConfirm header text spells out the side-effect.
    expect(
      await screen.findByText(/Will copy the packet to your clipboard and open Claude/),
    ).toBeInTheDocument();
  });

  it('routes move-to picker selections through the moveThread message', async () => {
    const sendMessage = installChromeMock(liveState());

    render(<App />);

    // Scope D — Workstream picker lives under the Workstreams tab.
    await goToTab('Workstreams');
    // Switch to the workstream that contains the test thread via the ws picker.
    fireEvent.click(await screen.findByRole('button', { name: /not set/ }));
    const wsRows = await screen.findAllByRole('button');
    const sidetrackPickerRow = wsRows.find(
      (b) =>
        b.className.includes('ws-picker-row') &&
        (b.textContent ?? '').trim().startsWith('Sidetrack'), // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    );
    if (sidetrackPickerRow === undefined) {
      throw new Error('Could not find Sidetrack picker row.');
    }
    fireEvent.click(sidetrackPickerRow);
    // v2 design pass 5: Move is behind the ⋯ overflow menu now.
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to workstream…' }));
    await screen.findByText('From: Sidetrack · Side-panel state machine review');
    const siblingButtons = screen.getAllByRole('button', { name: /Sibling/ });
    const siblingButton = siblingButtons.at(-1);
    if (siblingButton === undefined) {
      throw new Error('Expected the move picker to render a sibling workstream button.');
    }
    fireEvent.click(siblingButton);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.moveThread,
        threadId: 'bac_thread_test',
        workstreamId: 'bac_workstream_sibling',
      });
    });
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: messageTypes.postConnectionsFeedbackEvent,
          event: {
            type: 'user.organized.item',
            payload: {
              payloadVersion: 1,
              itemKind: 'thread',
              itemId: 'bac_thread_test',
              action: 'move',
              fromContainer: 'bac_workstream_root',
              toContainer: 'bac_workstream_sibling',
            },
          },
          clientEventId: expect.stringMatching(/^feedback-user\.organized\.item-/u),
        }),
      );
    });
  });

  it('routes drag/drop across workstream pills through the moveThread message', async () => {
    const sendMessage = installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });

    render(<App />);

    // Scope D — Workstream pills + picker live under Workstreams.
    await goToTab('Workstreams');
    fireEvent.click(await screen.findByRole('button', { name: /not set/ }));
    const wsRows = await screen.findAllByRole('button');
    const sidetrackPickerRow = wsRows.find(
      (b) =>
        b.className.includes('ws-picker-row') &&
        (b.textContent ?? '').trim().startsWith('Sidetrack'), // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    );
    if (sidetrackPickerRow === undefined) {
      throw new Error('Could not find Sidetrack picker row.');
    }
    fireEvent.click(sidetrackPickerRow);

    const threadRow = (await screen.findByText('[private]')).closest('.thread');
    expect(threadRow).not.toBeNull();
    if (threadRow === null) {
      return;
    }
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'uninitialized',
      setData: vi.fn(),
    };
    fireEvent.dragStart(threadRow, { dataTransfer });
    const siblingDropPill = screen.getByRole('button', { name: 'Sibling' });
    fireEvent.dragOver(siblingDropPill, { dataTransfer });
    fireEvent.drop(siblingDropPill, { dataTransfer });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.moveThread,
        threadId: 'bac_thread_test',
        workstreamId: 'bac_workstream_sibling',
      });
    });
  });

  it('routes tab-session drag/drop across workstream pills through the attribution endpoint', async () => {
    installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { accepted: {} } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // Scope D — Workstream pills (drop targets) live under Workstreams.
    await goToTab('Workstreams');
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'move',
      types: ['text/plain'],
      getData: vi.fn((type: string) => (type === 'text/plain' ? 'tses_test' : '')),
      setData: vi.fn(),
    };
    fireEvent.drop(await screen.findByRole('button', { name: 'Sibling' }), { dataTransfer });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:17373/v1/tabsessions/tses_test/attribute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ workstreamId: 'bac_workstream_sibling' }),
          headers: expect.objectContaining({
            'content-type': 'application/json',
            'x-bac-bridge-key': 'bridge-test-key',
          }),
        }),
      );
    });
  });

  it('renders the tab-session Inbox tab and posts move decisions', async () => {
    const sendMessage = installChromeMock(
      {
        ...liveState(),
        companionStatus: 'connected',
        activeTabUrl: 'https://example.test/research',
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const projection = {
      schemaVersion: 1,
      bySessionId: {
        tses_test: {
          tabSessionId: 'tses_test',
          openedAt: NOW,
          lastActivityAt: NOW,
          latestUrl: 'https://example.test/research',
          latestTitle: 'Research page',
          currentAttribution: {
            workstreamId: 'bac_workstream_root',
            source: 'user_asserted',
            observedAt: NOW,
            clientEventId: 'evt-1',
          },
          attributionHistory: [],
        },
        tses_inbox: {
          tabSessionId: 'tses_inbox',
          openedAt: NOW,
          lastActivityAt: NOW,
          latestUrl: 'https://copy.fail',
          latestTitle: 'Copy fail',
          attributionHistory: [],
        },
      },
      openSessionsByTabId: { tab_a: 'tses_test' },
    };
    // URL projection (Phase B): URL is the attribution unit, so the
    // panel's Inbox and Current-tab card read from /v1/visits/*. Mock
    // both alongside the legacy /v1/tabsessions/* endpoints — the
    // panel hits both during the initial load.
    const urlProjection = {
      schemaVersion: 1,
      byCanonicalUrl: {
        'https://example.test/research': {
          canonicalUrl: 'https://example.test/research',
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 1,
          tabSessionIds: ['tses_test'],
          latestUrl: 'https://example.test/research',
          latestTitle: 'Research page',
          currentAttribution: {
            workstreamId: 'bac_workstream_root',
            source: 'user_asserted',
            observedAt: NOW,
            clientEventId: 'evt-1',
          },
          attributionHistory: [],
          pageEvidence: {
            tier: 'content_features_only',
            evidenceRevision: 'evidence-research',
            semanticFeatureRevision: 'semantic-research',
            updatedAt: NOW,
            termCount: 64,
            keyphraseCount: 32,
            entityCount: 12,
            quality: 'high',
          },
        },
        'https://copy.fail': {
          canonicalUrl: 'https://copy.fail',
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 1,
          tabSessionIds: ['tses_inbox'],
          latestUrl: 'https://copy.fail',
          latestTitle: 'Copy fail',
          attributionHistory: [],
          pageEvidence: {
            tier: 'indexed_chunks',
            evidenceRevision: 'evidence-copy',
            semanticFeatureRevision: 'semantic-copy',
            updatedAt: NOW,
            termCount: 48,
            keyphraseCount: 24,
            entityCount: 8,
            quality: 'medium',
          },
        },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/tabsessions/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: projection }) };
      }
      if (url.includes('/v1/tabsessions/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [projection.bySessionId.tses_inbox],
              total: 1,
              limit: 51,
              offset: 0,
            },
          }),
        };
      }
      if (url.includes('/v1/visits/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: urlProjection }) };
      }
      if (url.includes('/v1/visits/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [urlProjection.byCanonicalUrl['https://copy.fail']],
              total: 1,
              limit: 51,
              offset: 0,
            },
          }),
        };
      }
      if (url.includes('/v1/visits/') && url.includes('/attribute')) {
        return { ok: true, status: 201, json: async () => ({ data: { accepted: {} } }) };
      }
      if (url.includes('/v1/tabsessions/tses_inbox/attribute')) {
        return { ok: true, status: 201, json: async () => ({ data: { accepted: {} } }) };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // Scope D — current-tab card lives in Now, inbox list lives in
    // Inbox. Assert the card under Now, then switch to Inbox to
    // assert the per-URL inbox row.
    await goToTab('Now');
    await waitFor(() => {
      expect(screen.getByTestId('focused-tab-attribution')).toHaveTextContent('Sidetrack');
    });
    expect(screen.getByTestId('focused-tab-attribution')).toHaveTextContent('Features only');
    await goToTab('Inbox');
    expect(await screen.findByText('Copy fail')).toBeInTheDocument();
    // Stage 5 polish — flat 4-action layout aligned with Current Tab.
    // Both the Current Tab card and the Inbox card now render "Pick
    // another…"; scope the click to the inbox card for this URL.
    const inboxCard = await screen.findByTestId('tab-session-card-https://copy.fail');
    expect(inboxCard).toHaveTextContent('Indexed chunks');
    fireEvent.click(within(inboxCard).getByRole('button', { name: 'Pick another…' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Sidetrack/ }));

    // Phase B routes attribute through /v1/visits/{url}/attribute.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:17373/v1/visits/${encodeURIComponent('https://copy.fail')}/attribute`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ workstreamId: 'bac_workstream_root' }),
        }),
      );
    });

    // task #50 Stage 2 — the SAME <PageTextPanel> ConnectionsView
    // mounts on a graph anchor is now on the current-tab card, driven
    // against the live focused URL. Its actions must dispatch the
    // page-content messages.
    //
    // Scope D — the current-tab card moved from Inbox to Now; switch
    // back to Now so the card is mounted before drilling in.
    await goToTab('Now');
    const currentTabCard = within(
      await screen.findByTestId('focused-tab-attribution'),
    ).getByTestId('current-tab-page-content-card');
    expect(currentTabCard).toHaveTextContent('Page text');
    // Coverage was fetched for the live focused URL (panel is wired to
    // the current tab, not a graph anchor).
    expect(sendMessage).toHaveBeenCalledWith(
      { type: messageTypes.pageContentCoverage, canonicalUrl: 'https://example.test/research' },
      expect.any(Function),
    );
    // Toggle expands; "Index page" dispatches the page-content action.
    fireEvent.click(within(currentTabCard).getByTestId('current-tab-summary-toggle'));
    fireEvent.click(within(currentTabCard).getByRole('button', { name: 'Index page' }));
    expect(sendMessage).toHaveBeenCalledWith(
      { type: messageTypes.pageContentIndexCurrent },
      expect.any(Function),
    );
  });

  it('renders resolver suggestions and confirms them through tab-session attribution', async () => {
    installChromeMock(
      {
        ...liveState(),
        companionStatus: 'connected',
        activeTabUrl: 'https://example.test/research',
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const projection = {
      schemaVersion: 1,
      bySessionId: {
        tses_suggested: {
          tabSessionId: 'tses_suggested',
          openedAt: NOW,
          lastActivityAt: NOW,
          latestUrl: 'https://example.test/research',
          latestTitle: 'Open research',
          attributionHistory: [],
        },
      },
      openSessionsByTabId: { tab_a: 'tses_suggested' },
    };
    const suggestion = {
      tabSessionId: 'tses_suggested',
      dryRun: true,
      decision: {
        action: 'suggest',
        workstreamId: 'bac_workstream_sibling',
        margin: 1.35,
      },
      fusedCandidates: [
        {
          workstreamId: 'bac_workstream_sibling',
          rawFusionLogit: 2.4,
          dominantSource: 'ppr',
          reasons: [
            {
              source: 'ppr',
              summary: 'Signed graph score 0.7',
              anchors: ['timeline-visit:https://example.test/research'],
            },
          ],
        },
      ],
    };
    // URL projection mirrors the tab-session shape. The suggestion is
    // resolved via /v1/visits/{url}/resolve and applied via attribute.
    const urlProjection = {
      schemaVersion: 1,
      byCanonicalUrl: {
        'https://example.test/research': {
          canonicalUrl: 'https://example.test/research',
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 1,
          tabSessionIds: ['tses_suggested'],
          latestUrl: 'https://example.test/research',
          latestTitle: 'Open research',
          attributionHistory: [],
        },
      },
    };
    const urlSuggestion = {
      canonicalUrl: 'https://example.test/research',
      dryRun: true,
      decision: {
        action: 'suggest',
        workstreamId: 'bac_workstream_sibling',
        margin: 1.35,
      },
      fusedCandidates: suggestion.fusedCandidates,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/tabsessions/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: projection }) };
      }
      if (url.includes('/v1/tabsessions/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { items: [], total: 0, limit: 51, offset: 0 },
          }),
        };
      }
      if (url.includes('/v1/tabsessions/tses_suggested/resolve')) {
        return { ok: true, status: 200, json: async () => ({ data: suggestion }) };
      }
      if (url.includes('/v1/visits/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: urlProjection }) };
      }
      if (url.includes('/v1/visits/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [urlProjection.byCanonicalUrl['https://example.test/research']],
              total: 1,
              limit: 51,
              offset: 0,
            },
          }),
        };
      }
      if (url.includes('/v1/visits/batch-resolve')) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            const rawBody = typeof init?.body === 'string' ? init.body : '{}';
            const body = JSON.parse(rawBody) as { readonly canonicalUrls?: readonly string[] };
            const results: Record<string, unknown> = {};
            for (const canonicalUrl of body.canonicalUrls ?? []) {
              if (canonicalUrl === 'https://example.test/research') {
                results[canonicalUrl] = urlSuggestion;
              }
            }
            return { data: { results } };
          },
        };
      }
      if (url.includes('/v1/visits/') && url.includes('/resolve')) {
        return { ok: true, status: 200, json: async () => ({ data: urlSuggestion }) };
      }
      if (url.includes('/v1/visits/') && url.includes('/attribute')) {
        return { ok: true, status: 201, json: async () => ({ data: { accepted: {} } }) };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // The duplicate fallback SuggestionBanner was removed; the same
    // Scope D — resolver suggestion + confirm now lives on the
    // current-tab card under the Now tab.
    await goToTab('Now');
    const banner = await screen.findByLabelText('Current tab attribution');
    // The card resolves its suggestion asynchronously ("Checking
    // signals…" → suggestion); wait for the confirm affordance.
    const confirm = await within(banner).findByRole(
      'button',
      { name: "Yes, that's right" },
      { timeout: 3000 },
    );
    expect(banner).toHaveTextContent('Sibling');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17373/v1/visits/batch-resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          canonicalUrls: ['https://example.test/research'],
          eventCandidateUrls: ['https://example.test/research'],
        }),
      }),
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('/v1/visits/https%3A%2F%2Fexample.test%2Fresearch/resolve'),
      ),
    ).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:17373/v1/visits/${encodeURIComponent('https://example.test/research')}/attribute`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ workstreamId: 'bac_workstream_sibling' }),
        }),
      );
    });
  });

  it('clears current-tab loading states after empty resolve and live page-evidence summary', async () => {
    installChromeMock(
      {
        ...liveState(),
        companionStatus: 'connected',
        activeTabUrl: 'https://news.ycombinator.com/item?id=48173962',
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const projection = {
      schemaVersion: 1,
      bySessionId: {},
      openSessionsByTabId: {},
    };
    const currentUrl = 'https://news.ycombinator.com/item?id=48173962';
    const urlProjection = {
      schemaVersion: 1,
      byCanonicalUrl: {
        [currentUrl]: {
          canonicalUrl: currentUrl,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 1,
          tabSessionIds: ['tses_hn'],
          latestUrl: currentUrl,
          latestTitle: 'WriteUp: 16 Bytes of x86 that turn Matrix rain into sound',
          attributionHistory: [],
        },
      },
    };
    const emptySuggestion = {
      canonicalUrl: currentUrl,
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/tabsessions/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: projection }) };
      }
      if (url.includes('/v1/tabsessions/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
        };
      }
      if (url.includes('/v1/visits/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: urlProjection }) };
      }
      if (url.includes('/v1/visits/inbox')) {
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
              canonicalUrl: currentUrl,
              pageEvidence: {
                tier: 'content_features_only',
                evidenceRevision: 'evidence-hn',
                semanticFeatureRevision: 'semantic-hn',
                updatedAt: NOW,
                termCount: 64,
                keyphraseCount: 32,
                entityCount: 12,
                quality: 'medium',
              },
              stale: false,
            },
          }),
        };
      }
      if (url.includes('/v1/visits/batch-resolve')) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            const rawBody = typeof init?.body === 'string' ? init.body : '{}';
            const body = JSON.parse(rawBody) as { readonly canonicalUrls?: readonly string[] };
            return {
              data: {
                results: Object.fromEntries(
                  (body.canonicalUrls ?? []).map((canonicalUrl) => [canonicalUrl, emptySuggestion]),
                ),
              },
            };
          },
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await goToTab('Now');

    const card = await screen.findByLabelText('Current tab attribution');
    await waitFor(() => {
      expect(card).toHaveTextContent('No signal yet');
    });
    expect(card).not.toHaveTextContent('Checking signals');
    await waitFor(() => {
      expect(within(card).getByTestId('page-evidence-capture-badge')).toHaveTextContent(
        'Features only',
      );
    });
    expect(within(card).getByTestId('page-evidence-capture-badge')).not.toHaveTextContent(
      'Indexing',
    );
  });

  it('retries the focused URL resolve after live page-evidence arrives', async () => {
    const currentUrl = 'https://news.ycombinator.com/item?id=48227446';
    installChromeMock(
      {
        ...liveState(),
        companionStatus: 'connected',
        activeTabUrl: currentUrl,
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const projection = {
      schemaVersion: 1,
      bySessionId: {},
      openSessionsByTabId: {},
    };
    const urlProjection = {
      schemaVersion: 1,
      byCanonicalUrl: {
        [currentUrl]: {
          canonicalUrl: currentUrl,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 1,
          tabSessionIds: ['tses_hn'],
          latestUrl: currentUrl,
          latestTitle: '22% Layoff at ClickUp | Hacker News',
          attributionHistory: [],
        },
      },
    };
    const emptySuggestion = {
      canonicalUrl: currentUrl,
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [],
    };
    const focusedSuggestion = {
      canonicalUrl: currentUrl,
      dryRun: true,
      decision: { action: 'inbox', margin: 0.22 },
      fusedCandidates: [
        {
          workstreamId: 'bac_workstream_sibling',
          rawFusionLogit: 2.4,
          dominantSource: 'similarity',
          reasons: [
            {
              source: 'similarity',
              summary: 'Similarity top 0.65',
              anchors: [`timeline-visit:${currentUrl}`],
            },
          ],
        },
      ],
    };
    let batchResolveCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/tabsessions/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: projection }) };
      }
      if (url.includes('/v1/tabsessions/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
        };
      }
      if (url.includes('/v1/visits/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: urlProjection }) };
      }
      if (url.includes('/v1/visits/inbox')) {
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
              canonicalUrl: currentUrl,
              pageEvidence: {
                tier: 'content_features_only',
                evidenceRevision: 'evidence-hn',
                semanticFeatureRevision: 'semantic-hn',
                updatedAt: NOW,
                termCount: 64,
                keyphraseCount: 32,
                entityCount: 7,
                quality: 'high',
              },
              stale: false,
            },
          }),
        };
      }
      if (url.includes('/v1/visits/batch-resolve')) {
        batchResolveCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => {
            const rawBody = typeof init?.body === 'string' ? init.body : '{}';
            const body = JSON.parse(rawBody) as { readonly canonicalUrls?: readonly string[] };
            const result = batchResolveCount < 3 ? emptySuggestion : focusedSuggestion;
            return {
              data: {
                results: Object.fromEntries(
                  (body.canonicalUrls ?? []).map((canonicalUrl) => [canonicalUrl, result]),
                ),
              },
            };
          },
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await goToTab('Now');

    const card = await screen.findByLabelText('Current tab attribution');
    await waitFor(
      () => {
        expect(card).toHaveTextContent('Sibling');
      },
      { timeout: 5_000 },
    );
    expect(card).not.toHaveTextContent('No signal yet');
    expect(batchResolveCount).toBeGreaterThanOrEqual(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17373/v1/visits/batch-resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          canonicalUrls: [currentUrl],
          eventCandidateUrls: [currentUrl],
        }),
      }),
    );
  });

  it('matches the focused tab cue by tabSessionId before falling back to URL', async () => {
    installChromeMock(
      {
        ...liveState(),
        companionStatus: 'connected',
        activeTabUrl: 'https://example.test/shared',
        activeTabSessionId: 'tses_b',
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const projection = {
      schemaVersion: 1,
      bySessionId: {
        tses_a: {
          tabSessionId: 'tses_a',
          openedAt: NOW,
          lastActivityAt: NOW,
          latestUrl: 'https://example.test/shared',
          latestTitle: 'Shared A',
          currentAttribution: {
            workstreamId: 'bac_workstream_root',
            source: 'user_asserted',
            observedAt: NOW,
            clientEventId: 'evt-a',
          },
          attributionHistory: [],
        },
        tses_b: {
          tabSessionId: 'tses_b',
          openedAt: NOW,
          lastActivityAt: NOW,
          latestUrl: 'https://example.test/shared',
          latestTitle: 'Shared B',
          currentAttribution: {
            workstreamId: 'bac_workstream_sibling',
            source: 'user_asserted',
            observedAt: NOW,
            clientEventId: 'evt-b',
          },
          attributionHistory: [],
        },
      },
      openSessionsByTabId: { tab_a: 'tses_a', tab_b: 'tses_b' },
    };
    // Phase B: attribution is per canonical URL, not per tab session.
    // Two tab sessions on the same URL collapse to one URL record;
    // the URL record's attribution (Sibling) is what shows.
    const urlProjection = {
      schemaVersion: 1,
      byCanonicalUrl: {
        'https://example.test/shared': {
          canonicalUrl: 'https://example.test/shared',
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 2,
          tabSessionIds: ['tses_a', 'tses_b'],
          latestUrl: 'https://example.test/shared',
          latestTitle: 'Shared B',
          currentAttribution: {
            workstreamId: 'bac_workstream_sibling',
            source: 'user_asserted',
            observedAt: NOW,
            clientEventId: 'evt-url',
          },
          attributionHistory: [],
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v1/tabsessions/projection')) {
          return { ok: true, status: 200, json: async () => ({ data: projection }) };
        }
        if (url.includes('/v1/tabsessions/inbox')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
          };
        }
        if (url.includes('/v1/visits/projection')) {
          return { ok: true, status: 200, json: async () => ({ data: urlProjection }) };
        }
        if (url.includes('/v1/visits/inbox')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
          };
        }
        return { ok: false, status: 404, text: async () => 'not found' };
      }),
    );

    render(<App />);

    // Scope D — the current-tab attribution card lives in Now now.
    await goToTab('Now');
    await waitFor(() => {
      expect(screen.getByTestId('focused-tab-attribution')).toHaveTextContent('Sibling');
    });
    expect(screen.getByTestId('focused-tab-attribution')).not.toHaveTextContent('Sidetrack');
  });

  it('exposes find-active-tab in the visible toolbar when the active tab matches a tracked thread', async () => {
    // R1.2 (feedback 2): find-active-tab RETURNED to the visible toolbar
    // — this user screenshares/demos daily, so the daily tools are one
    // click away. Same pinned aria-label so §13/e2e stay reachable.
    const state = liveState();
    installChromeMock(
      {
        ...state,
        activeTabUrl: 'https://claude.ai/chat/thread',
      },
      { [SETUP_COMPLETED_KEY]: true },
    );

    render(<App />);

    const findButton = await screen.findByRole('button', {
      name: 'Find active tab in side panel',
    });
    expect(findButton).toBeInTheDocument();
  });

  it('renders queue-item progress chips for auto-send state', async () => {
    const state = liveState();
    installChromeMock(
      {
        ...state,
        queueItems: [
          {
            bac_id: 'bac_queue_thread',
            text: 'Send the next ask.',
            scope: 'thread',
            targetId: 'bac_thread_test',
            status: 'pending',
            progress: 'waiting',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
      { [SETUP_COMPLETED_KEY]: true },
    );

    render(<App />);

    await goToTab('Threads');
    fireEvent.click(await screen.findByRole('button', { name: '1 queued' }));

    expect(await screen.findByText(/waiting for Claude's reply/)).toBeInTheDocument();
  });

  it('keeps shared workstream titles visible and masks screenshare-sensitive rows only when enabled', async () => {
    const state = liveState();
    const sharedState: WorkboardState = {
      ...state,
      workstreams: state.workstreams.map((workstream) =>
        workstream.bac_id === 'bac_workstream_root'
          ? { ...workstream, privacy: 'shared', screenShareSensitive: true }
          : workstream,
      ),
    };
    installChromeMock(sharedState, { [SETUP_COMPLETED_KEY]: true });

    const { unmount } = render(<App />);

    await goToTab('Threads');
    expect(await screen.findByText('Side-panel state machine review')).toBeInTheDocument();

    unmount();
    vi.unstubAllGlobals();
    installChromeMock({ ...sharedState, screenShareMode: true }, { [SETUP_COMPLETED_KEY]: true });
    render(<App />);
    await goToTab('Threads');
    expect(await screen.findByText('[private]')).toBeInTheDocument();
  });

  it('collapses lifecycle buckets and persists the requested bucket list', async () => {
    const state = liveState();
    const sendMessage = installChromeMock(
      {
        ...state,
        collapsedBuckets: ['stale'],
        threads: [
          ...state.threads,
          {
            bac_id: 'bac_thread_stale',
            provider: 'claude',
            threadUrl: 'https://claude.ai/chat/stale',
            title: 'Stale row',
            lastSeenAt: NOW,
            status: 'restorable',
            trackingMode: 'auto',
            primaryWorkstreamId: 'bac_workstream_root',
            tags: [],
          },
        ],
      },
      { [SETUP_COMPLETED_KEY]: true },
    );

    render(<App />);

    await goToTab('Threads');
    const staleHeader = await screen.findByRole('button', { name: /Stale or closed/u });
    expect(staleHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Stale row')).not.toBeInTheDocument();

    fireEvent.click(staleHeader);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.setCollapsedBuckets,
        collapsedBuckets: [],
      });
    });
  });

  it('find expands a collapsed lifecycle bucket before focusing the active tab row', async () => {
    const state = liveState();
    const sendMessage = installChromeMock(
      {
        ...state,
        activeTabUrl: 'https://claude.ai/chat/thread',
        collapsedBuckets: ['unread'],
      },
      { [SETUP_COMPLETED_KEY]: true },
      'https://claude.ai/chat/thread',
    );

    render(<App />);

    // R1.2: find-active-tab is back in the visible toolbar — click it
    // directly. Same aria-label + behaviour.
    const findButton = await screen.findByRole('button', {
      name: 'Find active tab in side panel',
    });
    fireEvent.click(findButton);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.setCollapsedBuckets,
        collapsedBuckets: [],
      });
    });
  });

  it('routes drag/drop from All threads through the moveThread message', async () => {
    const sendMessage = installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });

    render(<App />);

    await goToTab('Threads');
    const threadRow = (await screen.findByText('[private]')).closest('.thread');
    expect(threadRow).not.toBeNull();
    if (threadRow === null) {
      return;
    }
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'uninitialized',
      setData: vi.fn(),
    };
    fireEvent.dragStart(threadRow, { dataTransfer });
    fireEvent.drop(screen.getByRole('button', { name: 'Sibling' }), { dataTransfer });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.moveThread,
        threadId: 'bac_thread_test',
        workstreamId: 'bac_workstream_sibling',
      });
    });
  });
});

describe('master capture switch (the side-panel eye)', () => {
  it('pauses all capture when the eye is toggled off', async () => {
    const sendMessage = installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });

    render(<App />);

    const eye = await screen.findByRole('button', {
      name: 'Capture is on — click to pause all capture',
    });
    fireEvent.click(eye);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.saveLocalPreferences,
        preferences: { captureEnabled: false },
      });
    });
  });

  it('resumes capture when the eye is toggled back on', async () => {
    const base = liveState();
    const sendMessage = installChromeMock(
      { ...base, settings: { ...base.settings, captureEnabled: false } },
      { [SETUP_COMPLETED_KEY]: true },
    );

    render(<App />);

    const eye = await screen.findByRole('button', {
      name: 'Capture is paused — click to resume capture',
    });
    fireEvent.click(eye);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.saveLocalPreferences,
        preferences: { captureEnabled: true },
      });
    });
  });

  it('disables the capture-oriented icons while paused', async () => {
    const base = liveState();
    installChromeMock(
      { ...base, settings: { ...base.settings, captureEnabled: false } },
      { [SETUP_COMPLETED_KEY]: true },
    );

    render(<App />);

    // The eye itself stays live so the user can resume.
    const eye = await screen.findByRole('button', {
      name: 'Capture is paused — click to resume capture',
    });
    expect(eye).toBeEnabled();
    // Capture-mode toggle (Manual, since autoTrack defaults off) goes inert.
    expect(
      screen.getByRole('button', { name: 'Capture mode is Manual — switch to Auto' }),
    ).toBeDisabled();
    // So does the explicit capture-current-tab button.
    expect(screen.getByRole('button', { name: 'Capture current tab' })).toBeDisabled();
  });

  it('routes diagnostics through the toolbar overflow menu instead of standalone icons', async () => {
    installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });

    render(<App />);

    await screen.findByRole('main', { name: 'Sidetrack workboard' });
    // The old standalone health icon is gone — diagnostics live behind ⋯.
    expect(
      screen.queryByRole('button', { name: 'Open capture health diagnostics' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toolbar-overflow'));
    expect(await screen.findByRole('menuitem', { name: 'Capture health' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Design preview' })).toBeInTheDocument();
  });
});

// ── Per-page capture-state indicator on the current-tab card. When the
// master switch is paused OR the current site matches a no-capture
// rule, the card must say so explicitly instead of implying "Indexing…"
// / a stale tier, and must NOT round-trip the companion for coverage.
describe('current-tab capture-state indicator', () => {
  const BLOCKED_URL = 'https://www.pge.com/en/account/billing';

  // Mount the current-tab (Now) card against BLOCKED_URL with a fully
  // indexed page-evidence tier already present — so a NAIVE card would
  // show the green "Indexed chunks" tier and fire a coverage lookup. The
  // capture-state gate must override both.
  const renderNowCardFor = (
    settingsOverride: Partial<WorkboardState['settings']>,
  ): ReturnType<typeof installChromeMock> => {
    const base = liveState();
    const sendMessage = installChromeMock(
      {
        ...base,
        companionStatus: 'connected',
        activeTabUrl: BLOCKED_URL,
        settings: { ...base.settings, ...settingsOverride },
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const urlProjection = {
      schemaVersion: 1,
      byCanonicalUrl: {
        [BLOCKED_URL]: {
          canonicalUrl: BLOCKED_URL,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          visitCount: 1,
          tabSessionIds: ['tses_blocked'],
          latestUrl: BLOCKED_URL,
          latestTitle: 'Account billing',
          attributionHistory: [],
          pageEvidence: {
            tier: 'indexed_chunks',
            evidenceRevision: 'evidence-blocked',
            semanticFeatureRevision: 'semantic-blocked',
            updatedAt: NOW,
            termCount: 48,
            keyphraseCount: 24,
            entityCount: 8,
            quality: 'medium',
          },
        },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/visits/projection')) {
        return { ok: true, status: 200, json: async () => ({ data: urlProjection }) };
      }
      if (url.includes('/v1/visits/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    vi.stubGlobal('fetch', fetchMock);
    return sendMessage;
  };

  const pgeDomainRule = [
    {
      id: 'r_pge',
      kind: 'domain' as const,
      domain: 'pge.com',
      label: 'pge.com',
      createdAt: NOW,
    },
  ];

  it('shows a "Not captured — rule" badge for a blocklisted site and hides the tier / Indexing copy', async () => {
    const sendMessage = renderNowCardFor({ noCaptureRules: pgeDomainRule });

    render(<App />);

    await goToTab('Now');
    const card = await screen.findByTestId('focused-tab-attribution');
    // Wait for the projection (which carries an indexed_chunks tier) to
    // load, so the tier-suppression assertions below are meaningful: a
    // naive card WOULD now show the green "Indexed chunks" tier.
    await within(card).findByText('Account billing');
    const blockedBadge = await within(card).findByTestId('capture-blocked-badge');
    // Names the rule so the user knows WHY.
    expect(blockedBadge).toHaveTextContent('Not captured — rule: pge.com');
    // The stale "Indexed chunks" tier badge is suppressed…
    expect(within(card).queryByTestId('page-evidence-capture-badge')).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent('Indexed chunks');
    // …and no "Indexing" progress copy leaks in.
    expect(card).not.toHaveTextContent('Indexing');

    // Leak regression: no read-only coverage round-trip for a blocked page.
    expect(sendMessage).not.toHaveBeenCalledWith(
      { type: messageTypes.pageContentCoverage, canonicalUrl: BLOCKED_URL },
      expect.any(Function),
    );
  });

  it('disables the "Index page" action for a blocklisted site', async () => {
    renderNowCardFor({ noCaptureRules: pgeDomainRule });

    render(<App />);

    await goToTab('Now');
    const card = await screen.findByTestId('focused-tab-attribution');
    await within(card).findByText('Account billing');
    fireEvent.click(within(card).getByTestId('current-tab-summary-toggle'));
    expect(within(card).getByTestId('current-tab-index-page')).toBeDisabled();
    expect(within(card).getByTestId('current-tab-index-selection')).toBeDisabled();
    expect(within(card).getByTestId('current-tab-index-open-tabs')).toBeDisabled();
  });

  it('shows a "Capture paused" badge when the master switch is off and hides the tier / Indexing copy', async () => {
    const sendMessage = renderNowCardFor({ captureEnabled: false });

    render(<App />);

    await goToTab('Now');
    const card = await screen.findByTestId('focused-tab-attribution');
    // Wait for the indexed_chunks projection so tier-suppression is real.
    await within(card).findByText('Account billing');
    const pausedBadge = await within(card).findByTestId('capture-paused-badge');
    expect(pausedBadge).toHaveTextContent('Capture paused');
    // No tier, no Indexing copy.
    expect(within(card).queryByTestId('page-evidence-capture-badge')).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent('Indexed chunks');
    expect(card).not.toHaveTextContent('Indexing');

    // Leak regression: paused ⇒ no coverage round-trip either.
    expect(sendMessage).not.toHaveBeenCalledWith(
      { type: messageTypes.pageContentCoverage, canonicalUrl: BLOCKED_URL },
      expect.any(Function),
    );
  });

  it('renders the normal tier badge when the site is neither paused nor blocked', async () => {
    const sendMessage = renderNowCardFor({ noCaptureRules: [] });

    render(<App />);

    await goToTab('Now');
    // Wait for the projection to populate the card (title appears once
    // focusedTabSession is loaded), then assert the tier badge renders
    // and a coverage lookup fired — the un-gated normal path.
    await screen.findByText('Account billing');
    expect(await screen.findByTestId('page-evidence-capture-badge')).toBeInTheDocument();
    const card = screen.getByTestId('focused-tab-attribution');
    expect(within(card).queryByTestId('capture-blocked-badge')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('capture-paused-badge')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        { type: messageTypes.pageContentCoverage, canonicalUrl: BLOCKED_URL },
        expect.any(Function),
      );
    });
  });
});

// ── Capture lamp strip (R1 "Private Ledger" header spine). The lamp is
// the ONE always-visible privacy indicator: glyph + current domain +
// verdict (role=status aria-live=polite — the a11y fix for the reported
// "i don't even see a privacy change" incident). It reuses the SAME
// tri-state invariant as the current-tab card, so recording / paused /
// blocked stay in lock-step, and re-points the accent bus via
// [data-capture-state] on the panel root.
describe('capture lamp strip', () => {
  const SITE_URL = 'https://research.google.com/paper';

  const renderLamp = (
    settingsOverride: Partial<WorkboardState['settings']> = {},
  ): ReturnType<typeof installChromeMock> => {
    const base = liveState();
    const sendMessage = installChromeMock(
      {
        ...base,
        companionStatus: 'connected',
        activeTabUrl: SITE_URL,
        settings: { ...base.settings, ...settingsOverride },
      },
      { [SETUP_COMPLETED_KEY]: true },
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/visits/inbox')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
        };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    });
    vi.stubGlobal('fetch', fetchMock);
    return sendMessage;
  };

  // A 'domain' rule matches the eTLD+1 family (research.google.com →
  // google.com), so the rule's domain is the registrable domain.
  const googleDomainRule = [
    { id: 'r_g', kind: 'domain' as const, domain: 'google.com', label: 'google.com', createdAt: NOW },
  ];

  it('is present in every view with a role=status aria-live verdict', async () => {
    renderLamp();
    render(<App />);

    const strip = await screen.findByTestId('capture-lamp-strip');
    // Verdict carries the meaning (not color-only) and is announced.
    const verdict = within(strip).getByTestId('capture-lamp-verdict');
    expect(verdict).toHaveAttribute('role', 'status');
    expect(verdict).toHaveAttribute('aria-live', 'polite');

    // Still present after switching away from Now — it's the spine.
    await goToTab('Threads');
    expect(screen.getByTestId('capture-lamp-strip')).toBeInTheDocument();
  });

  it('reads "Recording this page" + retints the panel to recording by default', async () => {
    renderLamp();
    render(<App />);

    const verdict = await screen.findByTestId('capture-lamp-verdict');
    expect(verdict).toHaveTextContent('Recording this page');
    // The accent bus defaults to recording — no paused/blocked attribute.
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toHaveAttribute(
      'data-capture-state',
      'capturing',
    );
  });

  it('goes amber/paused when the master switch is off', async () => {
    renderLamp({ captureEnabled: false });
    render(<App />);

    const verdict = await screen.findByTestId('capture-lamp-verdict');
    expect(verdict).toHaveTextContent('Capture paused — everywhere');
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toHaveAttribute(
      'data-capture-state',
      'paused',
    );
    // No rule chip while merely paused.
    expect(screen.queryByTestId('capture-lamp-rule-chip')).not.toBeInTheDocument();
  });

  it('goes rose/blocked with a rule chip on a no-capture site', async () => {
    renderLamp({ noCaptureRules: googleDomainRule });
    render(<App />);

    const verdict = await screen.findByTestId('capture-lamp-verdict');
    expect(verdict).toHaveTextContent('Not captured — rule: google.com');
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toHaveAttribute(
      'data-capture-state',
      'blocked',
    );
    // The rule chip is the primary blocked affordance (→ Settings).
    expect(screen.getByTestId('capture-lamp-rule-chip')).toBeInTheDocument();
  });

  it('shows the current domain (mono) and moves the master eye into the strip', async () => {
    renderLamp();
    render(<App />);

    const strip = await screen.findByTestId('capture-lamp-strip');
    expect(within(strip).getByTestId('capture-lamp-domain')).toHaveTextContent('google.com');
    // The eye (capture-toggle) is now the strip's primary control and
    // keeps its testid + aria-pressed.
    const eye = within(strip).getByTestId('capture-toggle');
    expect(eye).toHaveClass('capture-eye');
    expect(eye).toHaveAttribute('aria-pressed', 'true');
  });

  it('reads a quiet composed idle state ("No page in focus", never "Recording") with no focused/active tab', async () => {
    const base = liveState();
    installChromeMock(
      { ...base, companionStatus: 'connected' },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);

    const strip = await screen.findByTestId('capture-lamp-strip');
    // With no page in focus the domain slot collapses (empty) so the
    // verdict isn't crowded by a placeholder that reads like a second
    // verdict — the verdict alone carries the meaning.
    expect(within(strip).getByTestId('capture-lamp-domain')).toHaveTextContent('');
    // The verdict must NOT over-claim a recording state with no page —
    // it reads the 'none' state and the accent bus goes neutral (idle),
    // not the warm 'capturing' tint.
    const verdict = within(strip).getByTestId('capture-lamp-verdict');
    expect(verdict).toHaveTextContent('No page in focus');
    expect(verdict).not.toHaveTextContent('Recording this page');
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toHaveAttribute(
      'data-capture-state',
      'idle',
    );
  });

  it('reads "Nothing to record here" on a non-http surface (chrome://)', async () => {
    const base = liveState();
    installChromeMock(
      { ...base, companionStatus: 'connected', activeTabUrl: 'chrome://settings/' },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);

    const strip = await screen.findByTestId('capture-lamp-strip');
    const verdict = within(strip).getByTestId('capture-lamp-verdict');
    expect(verdict).toHaveTextContent('Nothing to record here');
    expect(verdict).not.toHaveTextContent('Recording this page');
    // A chrome:// page has no registrable domain to show — the domain
    // slot collapses so the verdict carries the meaning uncrowded.
    expect(within(strip).getByTestId('capture-lamp-domain')).toHaveTextContent('');
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toHaveAttribute(
      'data-capture-state',
      'idle',
    );
  });
});

// ── Theme default follows the OS ('auto'). jsdom has no matchMedia, so
// the resolver falls back to light — no data-theme attribute is set,
// and the panel renders in the light "paper ledger" palette.
describe('theme default (auto follows system)', () => {
  it('resolves to light in a no-matchMedia environment (no data-theme)', async () => {
    installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true });
    render(<App />);

    await screen.findByRole('main', { name: 'Sidetrack workboard' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

// ── Connect-dot folds the old three-pill sp-status row into one quiet
// dot; the tri-state (vault / companion / recall) is PRESERVED on expand.
describe('connect-dot status', () => {
  it('expands to the preserved vault + companion detail on click', async () => {
    installChromeMock(
      { ...liveState(), companionStatus: 'connected' },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);

    const dot = await screen.findByTestId('connect-dot');
    fireEvent.click(dot);
    const popover = await screen.findByRole('dialog', { name: 'Connection status' });
    expect(within(popover).getByText('Vault')).toBeInTheDocument();
    expect(within(popover).getByText('Companion')).toBeInTheDocument();
  });
});

// ── R1.2 lamp control center — the two per-site capture toggles that
// live on the lamp strip's right side. Each is independently stateful:
// clicking blocks the current site (adds a rule), and on an
// already-blocked page the icon reads as active and clicking again
// re-enables capture (removes the rule). This drives the block ↔
// re-enable round-trip against a stateful rules store.
describe('lamp per-site capture controls', () => {
  const SITE_URL = 'https://research.google.com/paper';

  // A stateful chrome mock: addNoCaptureRule / removeNoCaptureRule
  // mutate a live rules list, and getWorkboardState returns the state
  // with the CURRENT rules — so the round-trip (block → active →
  // re-enable) reflects real store transitions the way the background
  // does. Returns the sendMessage spy + a peek at the live rules.
  const installStatefulRulesMock = (
    initialRules: readonly NoCaptureRule[] = [],
  ): { sendMessage: ReturnType<typeof vi.fn>; rules: () => readonly NoCaptureRule[] } => {
    let rules: NoCaptureRule[] = [...initialRules];
    const base = liveState();
    const buildState = (): WorkboardState => ({
      ...base,
      companionStatus: 'connected',
      activeTabUrl: SITE_URL,
      settings: { ...base.settings, noCaptureRules: rules },
    });
    const sendMessage = vi.fn((request: WorkboardRequest | { readonly type?: unknown }) => {
      const type = (request as { type?: unknown }).type;
      if (type === messageTypes.addNoCaptureRule) {
        const kind = (request as { kind?: 'domain' | 'similar' }).kind ?? 'domain';
        // Registrable domain of SITE_URL is google.com (the eTLD+1).
        const domain = 'google.com';
        if (!rules.some((r) => r.kind === kind && r.domain === domain)) {
          rules = [
            ...rules,
            kind === 'similar'
              ? {
                  id: `ncr_${kind}`,
                  kind: 'similar',
                  domain,
                  label: domain,
                  createdAt: NOW,
                  categoryTokens: [],
                }
              : { id: `ncr_${kind}`, kind: 'domain', domain, label: domain, createdAt: NOW },
          ];
        }
        return Promise.resolve({ ok: true, noCaptureRules: rules });
      }
      if (type === messageTypes.removeNoCaptureRule) {
        const ruleId = (request as { ruleId?: string }).ruleId;
        rules = rules.filter((r) => r.id !== ruleId);
        return Promise.resolve({ ok: true, noCaptureRules: rules });
      }
      // getWorkboardState (and everything else) returns the live state.
      return Promise.resolve({ ok: true, state: buildState(), request });
    });
    const get = vi.fn((query: StorageQuery): Promise<Record<string, unknown>> => {
      const values = { [SETUP_COMPLETED_KEY]: true } as Record<string, unknown>;
      if (typeof query === 'string') return Promise.resolve({ [query]: values[query] });
      if (Array.isArray(query))
        return Promise.resolve(Object.fromEntries(query.map((k) => [k, values[k]])));
      if (query !== null && query !== undefined)
        return Promise.resolve(
          Object.fromEntries(
            Object.entries(query).map(([k, fb]) => [k, values[k] ?? fb]),
          ),
        );
      return Promise.resolve({ ...values });
    });
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: { local: { get, set: vi.fn(() => Promise.resolve()) }, session: { get, set: vi.fn(() => Promise.resolve()) } },
      tabs: { query: vi.fn(() => Promise.resolve([{ url: SITE_URL }])) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v1/visits/inbox')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
          };
        }
        return { ok: false, status: 404, text: async () => 'not found' };
      }),
    );
    return { sendMessage, rules: () => rules };
  };

  it('renders both per-site controls (block domain + block similar) on a capturable page', async () => {
    installStatefulRulesMock();
    render(<App />);

    const controls = await screen.findByTestId('capture-lamp-controls');
    // Two per-site toggles + the global eye all live in the cluster.
    expect(within(controls).getByTestId('lamp-block-domain')).toBeInTheDocument();
    expect(within(controls).getByTestId('lamp-block-similar')).toBeInTheDocument();
    expect(within(controls).getByTestId('capture-toggle')).toBeInTheDocument();
    // Idle (no rule yet) → not pressed.
    expect(within(controls).getByTestId('lamp-block-domain')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('blocks this domain then re-enables it (round-trip against the rules store)', async () => {
    const { sendMessage, rules } = installStatefulRulesMock();
    render(<App />);

    const blockDomain = await screen.findByTestId('lamp-block-domain');
    // Not blocked initially.
    expect(blockDomain).toHaveAttribute('aria-pressed', 'false');

    // Click → adds a 'domain' rule for the current site.
    fireEvent.click(blockDomain);
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: messageTypes.addNoCaptureRule, kind: 'domain' }),
      );
    });
    // The store now holds one domain rule and the lamp flips to blocked.
    await waitFor(() => {
      expect(rules().some((r) => r.kind === 'domain')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('lamp-block-domain')).toHaveAttribute('aria-pressed', 'true');
    });
    // The verdict reflects the block + the accent bus repaints.
    expect(screen.getByTestId('capture-lamp-verdict')).toHaveTextContent('Not captured');
    expect(screen.getByRole('main', { name: 'Sidetrack workboard' })).toHaveAttribute(
      'data-capture-state',
      'blocked',
    );

    // Click again → removes the rule (re-enable capture round-trip).
    fireEvent.click(screen.getByTestId('lamp-block-domain'));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: messageTypes.removeNoCaptureRule, ruleId: 'ncr_domain' }),
      );
    });
    await waitFor(() => {
      expect(rules().some((r) => r.kind === 'domain')).toBe(false);
    });
    await waitFor(() => {
      expect(screen.getByTestId('lamp-block-domain')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('the block-similar control is independently stateful from block-domain', async () => {
    const { sendMessage, rules } = installStatefulRulesMock();
    render(<App />);

    const blockSimilar = await screen.findByTestId('lamp-block-similar');
    fireEvent.click(blockSimilar);
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: messageTypes.addNoCaptureRule, kind: 'similar' }),
      );
    });
    // A 'similar' rule exists; the similar control is active but the
    // domain control stays inactive (independent toggles).
    await waitFor(() => {
      expect(rules().some((r) => r.kind === 'similar')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('lamp-block-similar')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByTestId('lamp-block-domain')).toHaveAttribute('aria-pressed', 'false');
  });
});

// ── R1.2 Privacy section — the no-capture rules render INLINE as a real
// panel (feedback 5), reachable from the primary nav. It lists rule rows
// with a per-rule Purge action + the "add current site" affordance, so
// the user never jumps to Settings to see or change the list.
describe('Privacy section (inline no-capture rules panel)', () => {
  const SITE_URL = 'https://research.google.com/paper';
  const existingRule: NoCaptureRule = {
    id: 'ncr_existing',
    kind: 'domain',
    domain: 'pge.com',
    label: 'pge.com',
    createdAt: NOW,
  };

  const installPrivacyMock = (rules: readonly NoCaptureRule[]): ReturnType<typeof installChromeMock> => {
    const base = liveState();
    const sendMessage = installChromeMock(
      {
        ...base,
        companionStatus: 'connected',
        activeTabUrl: SITE_URL,
        settings: { ...base.settings, noCaptureRules: rules },
      },
      { [SETUP_COMPLETED_KEY]: true },
      SITE_URL,
    );
    return sendMessage;
  };

  it('renders the rules list inline with a Purge action per rule (no Settings jump)', async () => {
    // The list is populated via the listNoCaptureRules message the
    // NoCaptureRulesSection issues on mount; make the mock answer it.
    const base = liveState();
    const sendMessage = vi.fn((request: WorkboardRequest | { readonly type?: unknown }) => {
      const type = (request as { type?: unknown }).type;
      if (type === messageTypes.listNoCaptureRules) {
        return Promise.resolve({ ok: true, noCaptureRules: [existingRule] });
      }
      return Promise.resolve({
        ok: true,
        state: {
          ...base,
          companionStatus: 'connected',
          activeTabUrl: SITE_URL,
          settings: { ...base.settings, noCaptureRules: [existingRule] },
        },
        request,
      });
    });
    const get = vi.fn((query: StorageQuery): Promise<Record<string, unknown>> => {
      const values = { [SETUP_COMPLETED_KEY]: true } as Record<string, unknown>;
      if (typeof query === 'string') return Promise.resolve({ [query]: values[query] });
      if (Array.isArray(query))
        return Promise.resolve(Object.fromEntries(query.map((k) => [k, values[k]])));
      if (query !== null && query !== undefined)
        return Promise.resolve(
          Object.fromEntries(Object.entries(query).map(([k, fb]) => [k, values[k] ?? fb])),
        );
      return Promise.resolve({ ...values });
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      storage: {
        local: { get, set: vi.fn(() => Promise.resolve()) },
        session: { get, set: vi.fn(() => Promise.resolve()) },
      },
      tabs: { query: vi.fn(() => Promise.resolve([{ url: SITE_URL }])) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [], total: 0, limit: 51, offset: 0 } }),
      })),
    );

    render(<App />);

    // Navigate to Privacy via the primary nav (not Settings).
    fireEvent.click(await screen.findByTestId('section-nav-privacy'));

    // The inline rules panel mounts with a real rule row + Purge action.
    const row = await screen.findByTestId('no-capture-rule-row');
    expect(within(row).getByText('pge.com')).toBeInTheDocument();
    expect(within(row).getByTestId('purge-captured-data')).toBeInTheDocument();
    expect(within(row).getByTestId('remove-no-capture-rule')).toBeInTheDocument();
    // The Settings modal did NOT open — this is inline.
    expect(screen.queryByRole('dialog', { name: /Settings/ })).not.toBeInTheDocument();
  });

  it('offers an "add current site" affordance that adds a domain rule', async () => {
    const sendMessage = installPrivacyMock([]);
    render(<App />);

    fireEvent.click(await screen.findByTestId('section-nav-privacy'));
    const addDomain = await screen.findByTestId('privacy-add-domain');
    fireEvent.click(addDomain);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: messageTypes.addNoCaptureRule, kind: 'domain' }),
      );
    });
  });
});

// ── Read semantics: "unread" means a reply the user hasn't READ yet
// (status 'new'). Opening a reply marks it 'seen', which clears it from
// the active inbound list AND the Inbox badge; the thread still holds the
// reply. The "Helpful" button (which wrote status:'relevant' and falsely
// claimed a trainable recall.action emission — updateReminder never
// touches the recall-action path) is removed. Card actions are Open +
// Dismiss only.
describe('Inbound read semantics', () => {
  // A state with one UNREAD reply (bac_reminder_test / bac_thread_test)
  // plus one already-READ reply on a second tracked thread.
  const stateWithMixedReminders = (): WorkboardState => {
    const base = liveState();
    return {
      ...base,
      companionStatus: 'connected',
      threads: [
        ...base.threads,
        {
          bac_id: 'bac_thread_read',
          provider: 'claude',
          threadUrl: 'https://claude.ai/chat/read-thread',
          title: 'Already-read reply thread',
          lastSeenAt: NOW,
          status: 'active',
          trackingMode: 'auto',
          primaryWorkstreamId: 'bac_workstream_root',
          tags: [],
        },
      ],
      reminders: [
        ...base.reminders, // status 'new'
        {
          bac_id: 'bac_reminder_read',
          revision: 'rev_reminder_read',
          threadId: 'bac_thread_read',
          provider: 'claude',
          // Recent so it falls inside the 7-day "Read" group window
          // (which is measured against the real Date.now()).
          detectedAt: new Date(Date.now() - 60_000).toISOString(),
          status: 'seen',
        },
      ],
    };
  };

  it('badges the Inbox with the UNREAD (new) count only, ignoring read replies', async () => {
    installChromeMock(stateWithMixedReminders(), { [SETUP_COMPLETED_KEY]: true });
    render(<App />);
    // Two reminders exist (one 'new', one 'seen') but the badge counts
    // only the unread one.
    const badge = await screen.findByTestId('section-nav-badge-inbox');
    expect(badge.textContent).toBe('1');
  });

  it('shows only the UNREAD reply in the active list; the read reply is in the collapsed Read group', async () => {
    installChromeMock(stateWithMixedReminders(), { [SETUP_COMPLETED_KEY]: true });
    render(<App />);
    await goToTab('Inbound replies');
    // The unread thread's title is in the active list.
    expect(await screen.findByText('Side-panel state machine review')).toBeInTheDocument();
    // The read reply is NOT in the active list but IS recoverable in
    // the collapsed "Read" group (rendered in the DOM under <details>).
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Already-read reply thread')).toBeInTheDocument();
  });

  it('Open marks the reply read (status "seen"), which clears it from queue + badge', async () => {
    const sendMessage = installChromeMock(
      { ...liveState(), companionStatus: 'connected' },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);
    await goToTab('Inbound replies');
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.updateReminder,
        reminderId: 'bac_reminder_test',
        update: { status: 'seen' },
      });
    });
  });

  it('Dismiss fires updateReminder { status: "dismissed" }', async () => {
    const sendMessage = installChromeMock(
      { ...liveState(), companionStatus: 'connected' },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);
    await goToTab('Inbound replies');
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.updateReminder,
        reminderId: 'bac_reminder_test',
        update: { status: 'dismissed' },
      });
    });
  });

  it('renders no "Helpful" button (dead trainable control removed)', async () => {
    installChromeMock(
      { ...liveState(), companionStatus: 'connected' },
      { [SETUP_COMPLETED_KEY]: true },
    );
    render(<App />);
    await goToTab('Inbound replies');
    // The active Open button proves we're on the inbound surface.
    await screen.findByRole('button', { name: 'Open' });
    expect(screen.queryByText('Helpful')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark this reply as helpful' }),
    ).not.toBeInTheDocument();
  });
});
