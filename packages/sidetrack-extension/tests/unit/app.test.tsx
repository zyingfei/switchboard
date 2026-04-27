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

const installChromeMock = (state: WorkboardState) => {
  const sendMessage = vi.fn((request: WorkboardRequest) =>
    Promise.resolve({
      ok: true,
      state,
      request,
    }),
  );
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('live side-panel App wiring', () => {
  it('renders live state through M1 skeleton components and updates reminders', async () => {
    const sendMessage = installChromeMock(liveState());

    render(<App />);

    expect(await screen.findByText(/Companion: disconnected/)).toBeInTheDocument();
    expect(screen.getByText(/Provider extractor: ChatGPT extractor health/)).toBeInTheDocument();
    expect(screen.getByText('[private]')).toBeInTheDocument();
    expect(screen.getByText('[private — workstream item]')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Mark relevant'));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.updateReminder,
        reminderId: 'bac_reminder_test',
        update: { status: 'relevant' },
      });
    });
  });

  it('persists section collapse and routes move-to picker selections', async () => {
    const sendMessage = installChromeMock(liveState());

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Active Work hide/ }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: messageTypes.setCollapsedSections,
        collapsedSections: ['active-work'],
      });
    });

    fireEvent.click(screen.getByText('Move to…'));
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
