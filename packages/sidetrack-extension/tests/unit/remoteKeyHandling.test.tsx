import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteEngineRow } from '../../entrypoints/sidepanel/components/RemoteEngineRow';
import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';
import {
  REMOTE_ENGINE_STORAGE_KEY,
  clearRemoteApiKey,
  maskApiKey,
  readRemoteConfig,
  redactRemoteConfig,
  remoteHostOf,
  remotePrivacyMarker,
  saveRemoteConfig,
  type RemoteEngineConfig,
} from '../../src/sidepanel/nano/remoteConfig';
import { ContentEnrichmentAction } from '../../src/sidepanel/nano/ContentEnrichmentAction';
import type { EngineAvailability } from '../../src/sidepanel/nano/language';

// THE KEY IS THE WHOLE TEST. A user-supplied provider credential in a product
// whose premise is zero-outbound has exactly four properties it must never lose:
// it is stored on the DEVICE (never chrome.storage.sync, which replicates
// through the signed-in profile), it is never rendered back, it is removable in
// one click, and it never appears in anything the panel builds for someone else
// to read.

const SECRET = 'sk-live-9f2a7c4e1b8d6a3f';

const local: Record<string, unknown> = {};
const syncSet = vi.fn();
const syncGet = vi.fn(async () => ({}));

const installChrome = (): void => {
  for (const k of Object.keys(local)) delete local[k];
  syncSet.mockClear();
  syncGet.mockClear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in local ? { [key]: local[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) local[k] = v;
        },
        remove: async (key: string) => {
          delete local[key];
        },
      },
      // Present and watched. Nothing in this codebase may touch it.
      sync: { get: syncGet, set: syncSet, remove: vi.fn() },
    },
  };
};

const storedConfig = (): RemoteEngineConfig | undefined =>
  local[REMOTE_ENGINE_STORAGE_KEY] as RemoteEngineConfig | undefined;

beforeEach(() => {
  installChrome();
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)['chrome'];
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('remote API key — storage', () => {
  it('persists to chrome.storage.LOCAL and never to chrome.storage.sync', async () => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET });
    expect(storedConfig()?.apiKey).toBe(SECRET);
    // The whole reason deviceStore.ts names one area: sync would replicate the
    // credential off the device through the Chrome profile.
    expect(syncSet).not.toHaveBeenCalled();
    expect(syncGet).not.toHaveBeenCalled();
  });

  it('round-trips through readRemoteConfig, defaulting a missing record', async () => {
    expect((await readRemoteConfig()).enabled).toBe(false);
    expect((await readRemoteConfig()).apiKey).toBe('');
    await saveRemoteConfig({ enabled: true, apiKey: SECRET, model: 'gpt-4o-mini' });
    const back = await readRemoteConfig();
    expect(back.enabled).toBe(true);
    expect(back.model).toBe('gpt-4o-mini');
  });

  it('clearing wipes the key AND disables the engine', async () => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET });
    const after = await clearRemoteApiKey();
    expect(after.apiKey).toBe('');
    expect(after.enabled).toBe(false);
    expect(storedConfig()?.apiKey).toBe('');
    expect(syncSet).not.toHaveBeenCalled();
  });
});

describe('remote API key — masking', () => {
  it('shows a prefix and the last four, never the middle', () => {
    expect(maskApiKey(SECRET)).toBe('sk-…6a3f');
  });

  it('collapses a short key rather than effectively showing it whole', () => {
    expect(maskApiKey('sk-1234')).toBe('…34');
    expect(maskApiKey('')).toBe('');
  });
});

describe('remote API key — the config UI never renders it back', () => {
  it('shows only the mask, leaves the password field empty, and clears on demand', async () => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET });
    const onChanged = vi.fn();
    render(<RemoteEngineRow onChanged={onChanged} />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-remote-key-mask')).toHaveTextContent('sk-…6a3f');
    });
    // The secret is nowhere in the rendered document.
    expect(document.body.innerHTML).not.toContain(SECRET);
    // The input is write-only: type=password AND empty.
    const keyInput: HTMLInputElement = screen.getByTestId('hp-remote-key');
    expect(keyInput.type).toBe('password');
    expect(keyInput.value).toBe('');
    // The armed engine carries the standing, host-named privacy marker.
    expect(screen.getByTestId('hp-remote-warning')).toHaveTextContent(
      remotePrivacyMarker('api.openai.com'),
    );
    expect(screen.getByTestId('hp-remote-warning')).toHaveTextContent(
      '⚠ sends page text to api.openai.com',
    );

    fireEvent.click(screen.getByTestId('hp-remote-clear-key'));
    await waitFor(() => {
      expect(screen.queryByTestId('hp-remote-key-mask')).toBeNull();
    });
    expect(storedConfig()?.apiKey).toBe('');
    expect(storedConfig()?.enabled).toBe(false);
    // Clearing the key disarms the engine, so the marker goes too.
    expect(screen.queryByTestId('hp-remote-warning')).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it('saving a key drops the draft immediately — the typed value is not retained in the DOM', async () => {
    render(<RemoteEngineRow />);
    const keyInput = await screen.findByTestId('hp-remote-key');
    fireEvent.change(keyInput, { target: { value: SECRET } });
    fireEvent.click(screen.getByTestId('hp-remote-save'));
    await waitFor(() => {
      expect(storedConfig()?.apiKey).toBe(SECRET);
    });
    await waitFor(() => {
      expect((keyInput as HTMLInputElement).value).toBe('');
    });
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(syncSet).not.toHaveBeenCalled();
  });

  it('is OFF by default: an unconfigured row is not armed and shows no marker', async () => {
    render(<RemoteEngineRow />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-remote-enable')).not.toBeChecked();
    });
    expect(screen.queryByTestId('hp-remote-warning')).toBeNull();
    expect(screen.queryByTestId('hp-remote-clear-key')).toBeNull();
  });

  it('saving other fields does not silently wipe a stored key', async () => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET });
    render(<RemoteEngineRow />);
    const modelInput = await screen.findByTestId('hp-remote-model');
    fireEvent.change(modelInput, { target: { value: 'llama-3.1-8b' } });
    fireEvent.click(screen.getByTestId('hp-remote-save'));
    await waitFor(() => {
      expect(storedConfig()?.model).toBe('llama-3.1-8b');
    });
    expect(storedConfig()?.apiKey).toBe(SECRET);
  });
});

describe('the Now card marks a remote run, and reports its typed failures', () => {
  const armRemote = async (): Promise<void> => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET, model: 'gpt-4o-mini' });
  };
  const remoteAvailability: EngineAvailability = {
    nanoReady: false,
    webGpuLoaded: false,
    webGpuLoading: false,
    webGpuSupported: false,
    remoteReady: true,
    remoteHost: 'api.openai.com',
  };
  const LONG_TEXT =
    'CloudTrail writes organization events into one central bucket. Athena queries that bucket ' +
    'with a partition projection table so scans stay cheap even for a full year of activity.';

  const renderNowRow = () =>
    render(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/a' }}
        port={17_373}
        bridgeKey="k"
        availability={remoteAvailability}
        fetchText={async () => LONG_TEXT}
      />,
    );

  it('names the remote engine and carries the marker BEFORE anything is clicked', async () => {
    await armRemote();
    renderNowRow();
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent(
      'AI: remote model (api.openai.com)',
    );
    // The same marker string as everywhere else — text is about to leave.
    expect(screen.getByTestId('now-enrich-remote-warning')).toHaveTextContent(
      '⚠ sends page text to api.openai.com',
    );
    expect(screen.getByTestId('now-enrich-content-btn')).toBeEnabled();
    expect(screen.getByTestId('now-enrich-content-btn')).toHaveTextContent('Remote');
  });

  it('a successful remote run keeps the marker and records the provider model', async () => {
    await armRemote();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    'CloudTrail delivers organization events to a central bucket, and Athena queries them with partition projection.',
                },
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ accepted: 1 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    renderNowRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('gist saved');
    });
    // The disclosure outlives the run.
    expect(screen.getByTestId('now-enrich-remote-warning')).toHaveTextContent(
      '⚠ sends page text to api.openai.com',
    );
    const post = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/v1/enrichment/content'),
    ) as unknown as [string, RequestInit];
    const body = JSON.parse(post[1].body as string) as { items: readonly { model: string }[] };
    expect(body.items[0]?.model).toBe('gpt-4o-mini');
    // The companion never sees the key.
    expect(JSON.stringify(post[1])).not.toContain(SECRET);
    vi.unstubAllGlobals();
  });

  it('a 401 from the provider surfaces as the TYPED auth failure, and saves nothing', async () => {
    await armRemote();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/chat/completions')
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ accepted: 1 }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderNowRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'remote engine — the provider rejected the API key · nothing saved',
      );
    });
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/enrichment/content')),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it('a 429 surfaces as rate-limited rather than a generic model error', async () => {
    await armRemote();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    );
    renderNowRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'the provider is rate-limiting this key',
      );
    });
    vi.unstubAllGlobals();
  });

  it('no marker when a LOCAL engine is what runs — the claim tracks reality', () => {
    render(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/a' }}
        port={17_373}
        bridgeKey="k"
        availability={{ ...remoteAvailability, nanoReady: true }}
        fetchText={async () => LONG_TEXT}
      />,
    );
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent('AI: Nano ready');
    expect(screen.queryByTestId('now-enrich-remote-warning')).toBeNull();
  });
});

describe('remote API key — never in anything the panel builds for someone else', () => {
  it('redactRemoteConfig is the only projection, and it has no field to hold a key', async () => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET });
    const redacted = redactRemoteConfig(await readRemoteConfig());
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(JSON.stringify(redacted)).not.toContain('sk-');
    expect(redacted).toEqual({
      enabled: true,
      host: 'api.openai.com',
      model: 'gpt-4o-mini',
      hasKey: true,
    });
    expect(remoteHostOf('not a url')).toBe('not a url');
  });

  it('no companion-bound request the Health row makes carries the key, in any header or body', async () => {
    await saveRemoteConfig({ enabled: true, apiKey: SECRET });
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(async () => ({
        prompt: async () =>
          'CloudTrail writes organization events into a central bucket for later analysis.',
        destroy: vi.fn(),
      })),
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
            data: { markdown: 'User: how do I analyze CloudTrail logs?\n'.repeat(10) },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ accepted: 1, skipped: 0 }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="bridge-test-key" />);
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-eval'));
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-eval-results')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-ondevice-ai-enrich'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    });

    for (const call of fetchMock.mock.calls as unknown as readonly [
      RequestInfo | URL,
      RequestInit | undefined,
    ][]) {
      const serialized = JSON.stringify({
        url: String(call[0]),
        headers: call[1]?.headers ?? null,
        body: typeof call[1]?.body === 'string' ? call[1]?.body : null,
      });
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain('sk-live');
    }
    // …and the panel itself never rendered it.
    expect(document.body.innerHTML).not.toContain(SECRET);
    vi.unstubAllGlobals();
  });
});
