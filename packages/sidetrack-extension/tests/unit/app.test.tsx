import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
) => {
  const sendMessage = vi.fn((request: WorkboardRequest) =>
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

    // Click "Send to ▾".
    const sendToBtn = await screen.findByRole('button', { name: /Send to ▾/ });
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
    fireEvent.click(await screen.findByRole('button', { name: 'Move' }));
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
    installChromeMock(
      { ...sharedState, screenShareMode: true },
      { [SETUP_COMPLETED_KEY]: true },
    );
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
