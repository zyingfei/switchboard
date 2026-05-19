import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App, { formatBuildTimestamp } from '../../entrypoints/sidepanel/App';
import { messageTypes, type WorkboardRequest } from '../../src/messages';
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
  recallResponse: unknown = { ok: true, items: [] },
) => {
  const sendMessage = vi.fn((request: WorkboardRequest | { readonly type?: unknown }) => {
    if (request.type === messageTypes.recallQuery) {
      return Promise.resolve(recallResponse);
    }
    return Promise.resolve({
      ok: true,
      state,
      request,
    });
  });
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
    },
  });
  return sendMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live side-panel App wiring', () => {
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
    expect(await screen.findByText('Open threads')).toBeInTheDocument();
    expect(screen.getByText('Captures')).toBeInTheDocument();
    // ws-bar shows the current workstream label (default: "not set")
    expect(screen.getByRole('button', { name: /not set/ })).toBeInTheDocument();
  });

  it('searches indexed threads through the recall proxy', async () => {
    const sendMessage = installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true }, undefined, {
      ok: true,
      items: [
        {
          id: 'bac_thread_test:0',
          threadId: 'bac_thread_test',
          capturedAt: NOW,
          score: 0.91,
          title: 'Side-panel state machine review',
          threadUrl: 'https://claude.ai/chat/thread',
        },
      ],
    });

    render(<App />);

    await screen.findByRole('main', { name: 'Sidetrack workboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Search indexed threads' }));
    fireEvent.change(screen.getByPlaceholderText('Search indexed threads…'), {
      target: { value: 'state machine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText(/score 0\.91/)).toBeInTheDocument();
    expect(sendMessage).toHaveBeenCalledWith({
      type: messageTypes.recallQuery,
      q: 'state machine',
      limit: 10,
    });
  });

  it('shows thread search errors from the recall proxy', async () => {
    installChromeMock(liveState(), { [SETUP_COMPLETED_KEY]: true }, undefined, {
      ok: false,
      items: [],
      error: 'Companion not configured.',
    });

    render(<App />);

    await screen.findByRole('main', { name: 'Sidetrack workboard' });
    fireEvent.click(screen.getByRole('button', { name: 'Search indexed threads' }));
    fireEvent.change(screen.getByPlaceholderText('Search indexed threads…'), {
      target: { value: 'missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Companion not configured.')).toBeInTheDocument();
  });

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
    fireEvent.click(screen.getByRole('tab', { name: 'All threads' }));

    // Wait for the thread bucket to render under All-threads view.
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

    // #4 — the current-tab attribution card is Inbox-only now, so
    // switch to Inbox before asserting its contents.
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }));
    await waitFor(() => {
      expect(screen.getByTestId('focused-tab-attribution')).toHaveTextContent('Sidetrack');
    });
    expect(screen.getByTestId('focused-tab-attribution')).toHaveTextContent('Features only');
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
    const currentTabCard = within(
      screen.getByTestId('focused-tab-attribution'),
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
    // resolver suggestion + confirm now lives on the CURRENT TAB
    // attribution card (Inbox view), the single non-duplicated surface.
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }));
    const banner = await screen.findByLabelText('Current tab attribution');
    // The card resolves its suggestion asynchronously ("Checking
    // signals…" → suggestion); wait for the confirm affordance.
    const confirm = await within(banner).findByRole(
      'button',
      { name: "Yes, that's right" },
      { timeout: 3000 },
    );
    expect(banner).toHaveTextContent('Sibling');
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

    // #4 — the current-tab attribution card is Inbox-only now.
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }));
    await waitFor(() => {
      expect(screen.getByTestId('focused-tab-attribution')).toHaveTextContent('Sibling');
    });
    expect(screen.getByTestId('focused-tab-attribution')).not.toHaveTextContent('Sidetrack');
  });

  it('pulses the find icon when the active tab matches an unfocused tracked thread', async () => {
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
    expect(findButton.className).toContain('pulsing');
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

    fireEvent.click(await screen.findByRole('tab', { name: 'All threads' }));
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

    fireEvent.click(await screen.findByRole('tab', { name: 'All threads' }));
    expect(await screen.findByText('Side-panel state machine review')).toBeInTheDocument();

    unmount();
    vi.unstubAllGlobals();
    installChromeMock({ ...sharedState, screenShareMode: true }, { [SETUP_COMPLETED_KEY]: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'All threads' }));
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

    fireEvent.click(await screen.findByRole('tab', { name: 'All threads' }));
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

    fireEvent.click(await screen.findByRole('tab', { name: 'All threads' }));
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
