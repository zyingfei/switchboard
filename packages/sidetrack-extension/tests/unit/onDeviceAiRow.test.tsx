import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';

// The built-in Prompt API is feature-detected off globalThis.LanguageModel —
// absent in jsdom by default, stubbed per case here. The row must never
// trigger the multi-GB model download passively: create() only fires from
// the explicit button.

afterEach(() => {
  cleanup();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.restoreAllMocks();
});

describe('OnDeviceAiRow', () => {
  it('reports no-api when the browser does not expose LanguageModel', async () => {
    render(<OnDeviceAiRow />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-state')).toHaveTextContent(
        'not exposed by this browser',
      );
    });
  });

  it('reports ready when availability is available — without calling create()', async () => {
    const create = vi.fn();
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create,
    };
    render(<OnDeviceAiRow />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-state')).toHaveTextContent('ready');
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('downloadable state shows the button; clicking it starts create() with a progress monitor', async () => {
    let capturedMonitor:
      | ((m: {
          addEventListener: (type: string, cb: (e: { loaded: number }) => void) => void;
        }) => void)
      | undefined;
    const create = vi.fn(
      async (options?: { monitor?: typeof capturedMonitor }): Promise<{ destroy: () => void }> => {
        capturedMonitor = options?.monitor;
        // Never resolves during the test — download "in flight".
        return await new Promise<never>(() => undefined);
      },
    );
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'downloadable',
      create,
    };
    render(<OnDeviceAiRow />);
    const button = await screen.findByRole('button', { name: 'Download model' });
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(create).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-state')).toHaveTextContent('model downloading…');
    });
    expect(capturedMonitor).toBeDefined();
  });

  it('reports the unavailable state honestly', async () => {
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'unavailable',
      create: vi.fn(),
    };
    render(<OnDeviceAiRow />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-state')).toHaveTextContent(
        'this device/browser cannot run the model',
      );
    });
  });
});
