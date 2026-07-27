import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';

// The built-in Prompt API is feature-detected off globalThis.LanguageModel —
// absent in jsdom by default, stubbed per case here. The row must never
// trigger the multi-GB model download passively: create() only fires from
// the explicit button.

// The enrichment worker persists dedup hashes in chrome.storage.local; stub it
// so the button path (which POSTs) works under jsdom.
const installChromeStub = (): void => {
  const backing: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in backing ? { [key]: backing[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) backing[k] = v;
        },
        remove: async (key: string) => {
          delete backing[key];
        },
      },
    },
  };
};

afterEach(() => {
  cleanup();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  delete (globalThis as Record<string, unknown>)['chrome'];
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

  it('ready + companion access → eval button runs the observe-only title eval and renders before→after', async () => {
    const prompt = vi.fn(async () => 'CloudTrail log analysis pipeline design');
    const destroy = vi.fn();
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(async () => ({ prompt, destroy })),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/threads')) {
        return {
          ok: true,
          status: 200,
          // "ChatGPT" recurs 3× → structurally junk; "Real title" unique → kept out.
          json: async () => ({
            data: [
              { bac_id: 't1', title: 'ChatGPT' },
              { bac_id: 't2', title: 'ChatGPT' },
              { bac_id: 't3', title: 'ChatGPT' },
              { bac_id: 't4', title: 'A real specific title' },
            ],
          }),
        };
      }
      if (url.includes('/markdown')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { markdown: 'User: how do I analyze CloudTrail logs?\n'.repeat(10) },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="bridge-test-key" />);
    const button = await screen.findByTestId('hp-ondevice-ai-eval');
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-eval-results')).toHaveTextContent(
        'CloudTrail log analysis pipeline design',
      );
    });
    // Structural selection: only the 3 recurring-titled threads evaluated,
    // the unique real title untouched.
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledTimes(3);
    // Session settings declare ONLY what Nano can actually serve. It used to
    // declare en+zh; Chrome's built-in Prompt API does not support Chinese, so
    // that was a promise the model cannot keep (zh routes to WebGPU instead).
    const lm = (globalThis as { LanguageModel?: { create: ReturnType<typeof vi.fn> } })
      .LanguageModel;
    expect(lm?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      }),
    );
    // Observe-only: nothing but GETs — no POST/PUT anywhere.
    for (const call of fetchMock.mock.calls as unknown as readonly [
      RequestInfo | URL,
      RequestInit | undefined,
    ][]) {
      expect(call[1]?.method ?? 'GET').toBe('GET');
    }
    vi.unstubAllGlobals();
  });

  it('ready + companion access → "Enrich titles" button runs the persisting worker and shows stats', async () => {
    installChromeStub();
    const prompt = vi.fn(async () => 'CloudTrail cross-account log analysis');
    const destroy = vi.fn();
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(async () => ({ prompt, destroy })),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/threads')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { bac_id: 't1', title: '' },
              { bac_id: 't2', title: '' },
            ],
          }),
        };
      }
      if (url.includes('/markdown')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { markdown: `${url}\nUser: how do I analyze CloudTrail logs?\n`.repeat(6) },
          }),
        };
      }
      if (url.endsWith('/v1/enrichment/titles')) {
        return { ok: true, status: 200, json: async () => ({ accepted: 2, skipped: 0 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OnDeviceAiRow companionPort={17_374} bridgeKey="bridge-test-key" />);
    const button = await screen.findByTestId('hp-ondevice-ai-enrich');
    expect(button).toHaveTextContent('Enrich titles (10)');
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-enrich-stats')).toHaveTextContent(
        '2 generated · 2 accepted',
      );
    });
    // The worker PERSISTS: exactly one POST to the enrichment endpoint.
    const posts = (
      fetchMock.mock.calls as unknown as readonly [RequestInfo | URL, RequestInit | undefined][]
    ).filter(
      (c) => String(c[0]).endsWith('/v1/enrichment/titles') && (c[1]?.method ?? 'GET') === 'POST',
    );
    expect(posts).toHaveLength(1);
    vi.unstubAllGlobals();
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
