import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EngineModule from '../../src/sidepanel/nano/engine';
import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';
import {
  DEFAULT_LOCAL_MODEL_ID,
  LOCAL_MODELS,
  NANO_CLASS_BYTES_ON_DISK,
  NANO_CLASS_LOCAL_MODEL_ID,
  localModelSpec,
} from '../../src/sidepanel/nano/modelRegistry';
import {
  MODEL_FETCH_HOST,
  downloadButtonLabel,
  fetchProgressLabel,
  isNotCachedError,
  notCachedMessage,
} from '../../src/sidepanel/nano/modelFetch';

// THE FAILURE THIS SUITE PINS DOWN.
//
// The user selected the Nano-class local model in Health → Experiments, clicked
// load, and got:
//
//   Error: Could not locate file: "http://127.0.0.1:17374/v1/models/
//   onnx-community/gemma-3-4b-it-ONNX/resolve/main/config.json".
//
// Two independent causes, and this suite covers both halves of the fix:
//   A. that model id could never have worked here (multimodal, multi-graph
//      export against a single-graph loader) — the registry now declares a
//      single-graph, text-only, genuinely Nano-class model instead;
//   B. there was NO WAY to get any model into the companion's cache — the row
//      now offers the download BEFORE offering a load that would fail, and if a
//      load is attempted anyway the raw "Could not locate file" string never
//      reaches the user.

const PORT = 17_374;
const NANO_CLASS_SPEC = localModelSpec(NANO_CLASS_LOCAL_MODEL_ID);

const loadWebGpuEngineMock = vi.fn();
let isWebGpuLoadedFlag = false;

vi.mock('../../src/sidepanel/nano/engine', async (importActual) => {
  const actual = await importActual<typeof EngineModule>();
  return {
    ...actual,
    // jsdom has no GPU; the row must still render the real button gating.
    webGpuSupported: () => true,
    isWebGpuLoaded: () => isWebGpuLoadedFlag,
    loadWebGpuEngine: (opts: unknown) => loadWebGpuEngineMock(opts),
    resolveReadyEngine: async () => null,
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

/** The request URL as a string, whichever of fetch's three input shapes it is. */
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface StubOptions {
  /**
   * HTTP status the model-host HEAD probe returns FOR THE NANO-CLASS MODEL, per
   * call (last repeats). Probes for any other model id always 404 — the row
   * re-probes on every selection change, and letting the default model's probe
   * consume an entry would make the sequence depend on render order.
   */
  readonly headStatuses: readonly number[];
  /** Bodies the fetch-status GET returns, in order (last repeats). */
  readonly statusBodies?: readonly unknown[];
  /** Body the fetch POST returns. */
  readonly postBody?: unknown;
}

interface Stub {
  readonly mock: ReturnType<typeof vi.fn>;
  readonly posts: string[];
}

const installFetchStub = (options: StubOptions): Stub => {
  const posts: string[] = [];
  let headCall = 0;
  let statusCall = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') {
      if (!url.includes(NANO_CLASS_LOCAL_MODEL_ID)) return new Response(null, { status: 404 });
      const status =
        options.headStatuses[Math.min(headCall, options.headStatuses.length - 1)] ?? 404;
      headCall += 1;
      return new Response(null, { status });
    }
    if (method === 'POST' && url.includes('/fetch')) {
      posts.push(typeof init?.body === 'string' ? init.body : '');
      return json(options.postBody ?? {});
    }
    if (url.includes('/fetch')) {
      const bodies = options.statusBodies ?? [];
      const body = bodies[Math.min(statusCall, bodies.length - 1)];
      statusCall += 1;
      return json(body ?? {});
    }
    return json({ data: [] });
  });
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return { mock, posts };
};

const jobBody = (over: Record<string, unknown>): unknown => ({
  data: {
    modelId: NANO_CLASS_LOCAL_MODEL_ID,
    state: 'running',
    filesDone: 0,
    filesTotal: 7,
    bytesDone: 0,
    bytesTotal: NANO_CLASS_BYTES_ON_DISK,
    currentFile: null,
    host: MODEL_FETCH_HOST,
    ...over,
  },
});

/** Select the Nano-class model in the row's model picker. */
const selectNanoClassModel = async (): Promise<void> => {
  const select: HTMLSelectElement = await screen.findByTestId('hp-ondevice-ai-model-select');
  fireEvent.change(select, { target: { value: NANO_CLASS_LOCAL_MODEL_ID } });
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  loadWebGpuEngineMock.mockReset();
  loadWebGpuEngineMock.mockResolvedValue({ kind: 'webgpu', generate: async () => 'x' });
  isWebGpuLoadedFlag = false;
  installChromeStub();
});

afterEach(() => {
  cleanup();
  (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

// ---------------------------------------------------------------------------
// A. The registry entry.
// ---------------------------------------------------------------------------

describe('the local model registry declares a model our pipeline can actually load', () => {
  it('no longer offers gemma-3-4b anywhere — it is a multi-graph export, not a drop-in', () => {
    expect(LOCAL_MODELS.some((m) => m.id.includes('gemma-3-4b'))).toBe(false);
    // …and the fallback-by-id path does not resurrect it either: an unknown id
    // falls back to the default, it never resolves to the removed entry.
    expect(localModelSpec('onnx-community/gemma-3-4b-it-ONNX').id).toBe(DEFAULT_LOCAL_MODEL_ID);
  });

  it('offers Llama-3.2-3B-Instruct-ONNX with its MEASURED size and honest status', () => {
    expect(NANO_CLASS_LOCAL_MODEL_ID).toBe('onnx-community/Llama-3.2-3B-Instruct-ONNX');
    expect(NANO_CLASS_SPEC.params).toBe('3B');
    expect(NANO_CLASS_SPEC.paramsBillions).toBe(3);
    // q4f16, not q4: the q4 build (3.17GB) traps with "memory access out of
    // bounds" in the browser's 32-bit WASM address space; q4f16 (2.42GB) loads.
    expect(NANO_CLASS_SPEC.quantization).toBe('q4f16');
    expect(NANO_CLASS_SPEC.revision).toBe('main');
    // 3.26GB, summed from the HF blobs API — the number the button states.
    expect(NANO_CLASS_SPEC.approxBytesOnDisk).toBe(2_420_000_000);
    // Nobody has loaded it here, so it stays unverified however well the layout
    // checks out.
    // Was 'unverified' until it was actually loaded here (2026-07-28): q4f16
    // reaches ready in ~3.8 min and generates in ~61s on an M2. The status is
    // earned by a real load, never assumed.
    expect(NANO_CLASS_SPEC.status).toBe('verified');
  });

  it('declares the SINGLE-GRAPH file set, including both external-data shards', () => {
    expect(NANO_CLASS_SPEC.files).toEqual([
      'config.json',
      'generation_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1',
    ]);
    // The shape that made the 4B entry unloadable must not creep back in.
    expect(NANO_CLASS_SPEC.files.some((f) => f.includes('decoder_model_merged'))).toBe(false);
    expect(NANO_CLASS_SPEC.files.some((f) => f.includes('embed_tokens'))).toBe(false);
    expect(NANO_CLASS_SPEC.files.some((f) => f.includes('vision'))).toBe(false);
  });

  it('leaves the 1B q4 default untouched', () => {
    const one = localModelSpec(DEFAULT_LOCAL_MODEL_ID);
    expect(DEFAULT_LOCAL_MODEL_ID).toBe('onnx-community/gemma-3-1b-it-ONNX');
    expect(one.status).toBe('verified');
    expect(one.approxBytesOnDisk).toBe(819_000_000);
    expect(one.files).toEqual([
      'config.json',
      'generation_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_q4.onnx',
      'onnx/model_q4.onnx_data',
    ]);
  });
});

// ---------------------------------------------------------------------------
// B. The copy — what the user is told before consenting.
// ---------------------------------------------------------------------------

describe('download copy states the real cost and names the outbound host', () => {
  it('the button label carries BOTH the size and huggingface.co', () => {
    const label = downloadButtonLabel(NANO_CLASS_SPEC);
    expect(label).toContain('Download to companion');
    expect(label).toContain('2.4 GB');
    expect(label).toContain('huggingface.co');
  });

  it('the progress line reports files, percent, and the moving file', () => {
    const line = fetchProgressLabel({
      modelId: NANO_CLASS_LOCAL_MODEL_ID,
      state: 'running',
      filesDone: 5,
      filesTotal: 7,
      bytesDone: 2_000_000_000,
      bytesTotal: 4_000_000_000,
      currentFile: 'onnx/model_q4f16.onnx_data_1',
      host: MODEL_FETCH_HOST,
    });
    expect(line).toContain('5/7 files');
    expect(line).toContain('50%');
    expect(line).toContain('onnx/model_q4f16.onnx_data_1');
    expect(line).toContain('huggingface.co');
  });

  it('omits the percent rather than faking one when the bundle could not be sized', () => {
    const line = fetchProgressLabel({
      modelId: NANO_CLASS_LOCAL_MODEL_ID,
      state: 'running',
      filesDone: 1,
      filesTotal: 7,
      bytesDone: 12_345,
      bytesTotal: 0,
      currentFile: null,
      host: MODEL_FETCH_HOST,
    });
    expect(line).toContain('1/7 files');
    expect(line).not.toContain('%');
  });

  it('the not-cached message points at the STEP, never at the URL', () => {
    const message = notCachedMessage(NANO_CLASS_SPEC);
    expect(message).toContain('not on the companion yet');
    expect(message).toContain('2.4 GB');
    expect(message).toContain('huggingface.co');
    expect(message).not.toContain('Could not locate file');
    expect(message).not.toContain('127.0.0.1');
  });

  it('recognizes the raw transformers.js failure it replaces', () => {
    expect(
      isNotCachedError(
        'Error: Could not locate file: "http://127.0.0.1:17374/v1/models/onnx-community/x/resolve/main/config.json".',
      ),
    ).toBe(true);
    expect(isNotCachedError('WebGPU adapter request failed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. The row.
// ---------------------------------------------------------------------------

describe('OnDeviceAiRow — a model the companion does not have', () => {
  it('offers Download INSTEAD of Load when the model host 404s config.json', async () => {
    installFetchStub({ headStatuses: [404] });
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();

    const download = await screen.findByTestId('hp-ondevice-ai-model-download');
    // The cost and the outbound are on the button itself — not in a tooltip,
    // not in a confirm dialog the user could skip.
    expect(download).toHaveTextContent('2.4 GB');
    expect(download).toHaveTextContent('huggingface.co');
    // A load that would fail is not offered at all.
    expect(screen.queryByTestId('hp-ondevice-ai-webgpu-load')).not.toBeInTheDocument();
  });

  it('offers Load (not Download) when the model host already serves config.json', async () => {
    installFetchStub({ headStatuses: [200] });
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();

    expect(await screen.findByTestId('hp-ondevice-ai-webgpu-load')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('hp-ondevice-ai-model-download')).not.toBeInTheDocument();
    });
  });

  it('POSTs the registry-declared file list and renders progress from the job status', async () => {
    const stub = installFetchStub({
      headStatuses: [404],
      postBody: jobBody({}),
      statusBodies: [
        jobBody({
          filesDone: 5,
          bytesDone: 2_000_000_000,
          currentFile: 'onnx/model_q4f16.onnx_data_1',
        }),
      ],
    });
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-model-download'));

    // The companion is told EXACTLY which files to pull — it never enumerates
    // the repo or guesses a layout.
    await waitFor(() => {
      expect(stub.posts).toHaveLength(1);
    });
    expect(JSON.parse(stub.posts[0] ?? '')).toEqual({ files: NANO_CLASS_SPEC.files });

    // The first line comes from the POST's own reply, the next from the poll —
    // wait for the polled one rather than racing it.
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-model-download-progress')).toHaveTextContent(
        '5/7 files',
      );
    });
    const progress = screen.getByTestId('hp-ondevice-ai-model-download-progress');
    expect(progress).toHaveTextContent('onnx/model_q4f16.onnx_data_1');
    expect(progress).toHaveTextContent('huggingface.co');
    // Neither button is live mid-download — one job at a time.
    expect(screen.queryByTestId('hp-ondevice-ai-model-download')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hp-ondevice-ai-webgpu-load')).not.toBeInTheDocument();
  });

  it('offers Load once the download completes — via a re-probe, not an assumption', async () => {
    installFetchStub({
      // 404 at mount (not cached) → 200 once the job reports done.
      headStatuses: [404, 200],
      postBody: jobBody({}),
      statusBodies: [jobBody({ state: 'done', filesDone: 7, bytesDone: NANO_CLASS_BYTES_ON_DISK })],
    });
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-model-download'));

    expect(await screen.findByTestId('hp-ondevice-ai-webgpu-load')).toBeInTheDocument();
    expect(screen.queryByTestId('hp-ondevice-ai-model-download')).not.toBeInTheDocument();
  });

  it('surfaces a refused download (kill switch off) as its own error, not as a load failure', async () => {
    installFetchStub({ headStatuses: [404] });
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 404 });
        if ((init?.method ?? 'GET') === 'POST') {
          return json({ status: 403, code: 'MODEL_FETCH_DISABLED', title: 'x' }, 403);
        }
        void input;
        return json({ data: [] });
      },
    );
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-model-download'));

    const err = await screen.findByTestId('hp-ondevice-ai-model-download-error');
    expect(err).toHaveTextContent('SIDETRACK_MODEL_FETCH=0');
    expect(loadWebGpuEngineMock).not.toHaveBeenCalled();
  });
});

describe('OnDeviceAiRow — a Load attempted on an uncached model', () => {
  it('never starts the load, and says the actionable thing instead of the raw URL error', async () => {
    // The mount probe is indeterminate (companion hiccup) so the row does NOT
    // hide the Load button — an unreachable companion must not be read as "the
    // model is missing". The click's OWN pre-check is what catches it.
    let headCall = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'HEAD') {
          headCall += 1;
          if (headCall === 1) throw new Error('connection refused');
          return new Response(null, { status: 404 });
        }
        return json({ data: [] });
      },
    );
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-webgpu-load'));

    const err = await screen.findByTestId('hp-ondevice-ai-webgpu-error');
    expect(err).toHaveTextContent('not on the companion yet');
    expect(err).not.toHaveTextContent('Could not locate file');
    // The point of the pre-check: the multi-GB browser load never started.
    expect(loadWebGpuEngineMock).not.toHaveBeenCalled();
    // …and the row now offers the step that fixes it.
    expect(await screen.findByTestId('hp-ondevice-ai-model-download')).toBeInTheDocument();
  });

  it('translates a raw "Could not locate file" thrown mid-load into the same actionable state', async () => {
    // config.json IS cached (probe 200) but a weight file is not, so the
    // failure only shows up inside transformers.js. The user must still get the
    // step, not the URL.
    installFetchStub({ headStatuses: [200] });
    loadWebGpuEngineMock.mockRejectedValue(
      new Error(
        'Could not locate file: "http://127.0.0.1:17374/v1/models/onnx-community/Llama-3.2-3B-Instruct-ONNX/resolve/main/onnx/model_q4.onnx_data".',
      ),
    );
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-webgpu-load'));

    const err = await screen.findByTestId('hp-ondevice-ai-webgpu-error');
    expect(err).toHaveTextContent('not on the companion yet');
    expect(err).not.toHaveTextContent('Could not locate file');
    expect(await screen.findByTestId('hp-ondevice-ai-model-download')).toBeInTheDocument();
  });

  it('still reports an UNRELATED load failure verbatim (no false "download it" advice)', async () => {
    installFetchStub({ headStatuses: [200] });
    loadWebGpuEngineMock.mockRejectedValue(new Error('WebGPU adapter request failed'));
    render(<OnDeviceAiRow companionPort={PORT} bridgeKey="k" />);
    await selectNanoClassModel();
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-webgpu-load'));

    const err = await screen.findByTestId('hp-ondevice-ai-webgpu-error');
    expect(err).toHaveTextContent('WebGPU adapter request failed');
    expect(err).not.toHaveTextContent('not on the companion yet');
  });
});
