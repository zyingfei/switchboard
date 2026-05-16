import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProducerPin } from './ProducerPin';
import type { ConnectionEdgeProducedBy } from './types';

interface ChromeStorageStub {
  readonly local: {
    readonly get: (key: string) => Promise<Record<string, unknown>>;
    readonly set: (entries: Record<string, unknown>) => Promise<void>;
    readonly remove: (key: string) => Promise<void>;
  };
}

const installChromeStub = (): {
  storage: Record<string, unknown>;
  chrome: { storage: ChromeStorageStub };
} => {
  const backing: Record<string, unknown> = {};
  const stub: { storage: ChromeStorageStub } = {
    storage: {
      local: {
        get: async (key: string) => {
          if (key in backing) return { [key]: backing[key] };
          return {};
        },
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) backing[k] = v;
        },
        remove: async (key: string) => {
          delete backing[key];
        },
      },
    },
  };
  (globalThis as unknown as { chrome: typeof stub }).chrome = stub;
  return { storage: backing, chrome: stub };
};

describe('ProducerPin', () => {
  beforeEach(() => {
    installChromeStub();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['chrome'];
    vi.restoreAllMocks();
  });

  it('renders nothing when producedBy has no revisionId', () => {
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'event-log',
      eventType: 'thread.upserted',
    };
    const { container } = render(<ProducerPin producedBy={producedBy} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a pin button for a revisioned producer', async () => {
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'ranker',
      revisionId: 'abc123def456',
    };
    render(<ProducerPin producedBy={producedBy} />);
    expect(await screen.findByTestId('producer-pin-ranker')).toBeTruthy();
    expect(screen.getByTestId('producer-pin-ranker-pin').textContent).toBe('Pin this version');
    expect(screen.getByTestId('producer-pin-ranker-label').textContent).toContain(
      'Closest-visit ranker',
    );
    expect(screen.getByTestId('producer-pin-ranker-label').textContent).toContain('rev abc123de');
  });

  it('clicking Pin writes to chrome.storage.local under the source-namespaced key', async () => {
    const { storage } = installChromeStub();
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'ranker',
      revisionId: 'abc123def456',
    };
    render(<ProducerPin producedBy={producedBy} />);
    fireEvent.click(await screen.findByTestId('producer-pin-ranker-pin'));
    await waitFor(() => {
      expect(storage['sidetrack.producerPin.ranker']).toBe('abc123def456');
    });
  });

  it('renders Unpin when the active edge matches the pinned revision', async () => {
    const { storage } = installChromeStub();
    storage['sidetrack.producerPin.ranker'] = 'abc123def456';
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'ranker',
      revisionId: 'abc123def456',
    };
    render(<ProducerPin producedBy={producedBy} />);
    expect(await screen.findByTestId('producer-pin-ranker-unpin')).toBeTruthy();
  });

  it('flags "other version pinned" when the active edge differs from the pinned revision', async () => {
    const { storage } = installChromeStub();
    storage['sidetrack.producerPin.ranker'] = 'oldrevisionXX';
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'ranker',
      revisionId: 'newrevisionXX',
    };
    render(<ProducerPin producedBy={producedBy} />);
    expect(await screen.findByTestId('producer-pin-ranker-other')).toBeTruthy();
    expect(screen.getByTestId('producer-pin-ranker-pin').textContent).toBe('Pin this version');
  });

  it('shows correction count when provided', async () => {
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'ranker',
      revisionId: 'abc123def456',
    };
    render(
      <ProducerPin
        producedBy={producedBy}
        producerLabel="Closest-visit ranker v3"
        trainedFromCorrectionCount={142}
      />,
    );
    expect((await screen.findByTestId('producer-pin-ranker-label')).textContent).toContain(
      'learned from 142 corrections',
    );
  });

  it('clicking Unpin removes the pin', async () => {
    const { storage } = installChromeStub();
    storage['sidetrack.producerPin.ranker'] = 'abc123def456';
    const producedBy: ConnectionEdgeProducedBy = {
      source: 'ranker',
      revisionId: 'abc123def456',
    };
    render(<ProducerPin producedBy={producedBy} />);
    fireEvent.click(await screen.findByTestId('producer-pin-ranker-unpin'));
    await waitFor(() => {
      expect(storage['sidetrack.producerPin.ranker']).toBeUndefined();
    });
  });
});
