import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from '../../entrypoints/sidepanel/App';
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
      return Promise.resolve(
        Object.fromEntries(query.map((key) => [key, localValues[key]])),
      );
    }
    if (query !== null && query !== undefined) {
      return Promise.resolve(
        Object.fromEntries(
          Object.entries(query).map(([key, fallback]) => [
            key,
            localValues[key] ?? fallback,
          ]),
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
    storage: { local: { get, set } },
  });
  return sendMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live side-panel App wiring', () => {
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

  it('routes move-to picker selections through the moveThread message', async () => {
    const sendMessage = installChromeMock(liveState());

    render(<App />);

    // Switch to the workstream that contains the test thread via the ws picker.
    fireEvent.click(await screen.findByRole('button', { name: /not set/ }));
    const wsRows = await screen.findAllByRole('button');
    const sidetrackPickerRow = wsRows.find((b) =>
      b.className.includes('ws-picker-row') &&
      (b.textContent ?? '').trim().startsWith('Sidetrack'), // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    );
    if (sidetrackPickerRow === undefined) {
      throw new Error('Could not find Sidetrack picker row.');
    }
    fireEvent.click(sidetrackPickerRow);
    fireEvent.click(await screen.findByText('Move to…'));
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
});
