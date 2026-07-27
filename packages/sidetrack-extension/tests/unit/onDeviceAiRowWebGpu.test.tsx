import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EngineModule from '../../src/sidepanel/nano/engine';
import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';

// The WebGPU load path in the Health row must NEVER pull transformers.js / a GPU
// in jsdom. We mock the engine module's load + support helpers, keeping the
// nano-availability helpers real, so the row's button gating, progress render,
// and engine-label are exercised without a real model load.

const loadWebGpuEngineMock = vi.fn();
const webGpuSupportedMock = vi.fn(() => true);
let isWebGpuLoadedFlag = false;

vi.mock('../../src/sidepanel/nano/engine', async (importActual) => {
  const actual = await importActual<typeof EngineModule>();
  return {
    ...actual,
    webGpuSupported: () => webGpuSupportedMock(),
    isWebGpuLoaded: () => isWebGpuLoadedFlag,
    loadWebGpuEngine: (opts: { onProgress?: (p: { file: string; percent: number }) => void }) =>
      loadWebGpuEngineMock(opts),
    // After a load, resolveReadyEngine should hand back a webgpu engine so the
    // eval/enrich buttons enable. Model choice mirrors the real policy: nano
    // wins when available, else the loaded webgpu engine.
    resolveReadyEngine: async () => {
      const nano = await actual.nanoEngineIfAvailable();
      if (nano !== null) return nano;
      return isWebGpuLoadedFlag
        ? { kind: 'webgpu' as const, generate: async () => 'x' }
        : null;
    },
  };
});

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

beforeEach(() => {
  loadWebGpuEngineMock.mockReset();
  webGpuSupportedMock.mockReset();
  webGpuSupportedMock.mockReturnValue(true);
  isWebGpuLoadedFlag = false;
});

afterEach(() => {
  cleanup();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  delete (globalThis as Record<string, unknown>)['chrome'];
  vi.restoreAllMocks();
});

describe('OnDeviceAiRow — WebGPU fallback', () => {
  it('shows the WebGPU load button ONLY when nano is not available and the companion is connected', async () => {
    // No LanguageModel exposed → nano state 'no-api'; companion connected.
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    const btn = await screen.findByTestId('hp-ondevice-ai-webgpu-load');
    expect(btn).toHaveTextContent('Load local model (WebGPU · ~800MB, from companion)');
  });

  it('does NOT show the load button when nano IS available', async () => {
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(),
    };
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-state')).toHaveTextContent('ready');
    });
    expect(screen.queryByTestId('hp-ondevice-ai-webgpu-load')).not.toBeInTheDocument();
  });

  it('shows an honest "not available" line when the browser has no WebGPU adapter', async () => {
    webGpuSupportedMock.mockReturnValue(false);
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-webgpu-unsupported')).toHaveTextContent(
        'WebGPU not available in this browser',
      );
    });
    expect(screen.queryByTestId('hp-ondevice-ai-webgpu-load')).not.toBeInTheDocument();
  });

  it('clicking load renders per-file progress, then a ready line, and engine-labeled eval/enrich buttons', async () => {
    installChromeStub();
    // The mocked load reports one progress event, flips the loaded flag, resolves.
    loadWebGpuEngineMock.mockImplementation(
      async (opts: { onProgress?: (p: { file: string; percent: number }) => void }) => {
        opts.onProgress?.({ file: 'model.onnx_data', percent: 73 });
        isWebGpuLoadedFlag = true;
        return { kind: 'webgpu', generate: async () => 'x' };
      },
    );
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    const btn = await screen.findByTestId('hp-ondevice-ai-webgpu-load');
    fireEvent.click(btn);
    expect(loadWebGpuEngineMock).toHaveBeenCalledTimes(1);
    // Ready line renders once loaded…
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-webgpu-state')).toHaveTextContent(
        'local model ready (WebGPU)',
      );
    });
    // …and the eval/enrich buttons enable, labeled with the active engine.
    const evalBtn = await screen.findByTestId('hp-ondevice-ai-eval');
    expect(evalBtn).toHaveTextContent('· WebGPU');
    const enrichBtn = screen.getByTestId('hp-ondevice-ai-enrich');
    expect(enrichBtn).toHaveTextContent('· WebGPU');
  });
});
