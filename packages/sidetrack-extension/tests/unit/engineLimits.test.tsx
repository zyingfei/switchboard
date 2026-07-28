import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NANO_FALLBACK_MAX_INPUT_CHARS,
  REMOTE_MAX_INPUT_CHARS,
  __resetEngineLimitsForTest,
  compactCount,
  formatEngineLimits,
  formatReduction,
  limitsFor,
  prepareInput,
  probeNanoLimits,
  type EngineLimits,
} from '../../src/sidepanel/nano/engineLimits';
import {
  LOCAL_MODELS,
  NANO_CLASS_LOCAL_MODEL_ID,
  WEBGPU_1B_MAX_INPUT_CHARS,
  WEBGPU_3B_MAX_INPUT_CHARS,
  formatModelSize,
  localModelSpec,
} from '../../src/sidepanel/nano/modelRegistry';
import { synthesizeGist } from '../../src/sidepanel/nano/gistSynthesis';
import { GIST_PROMPT_PREFIX } from '../../src/sidepanel/nano/titleSynthesis';
import {
  ContentEnrichmentAction,
  coverageCopy,
} from '../../src/sidepanel/nano/ContentEnrichmentAction';
import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';
import type { EngineAvailability } from '../../src/sidepanel/nano/language';
import type { BuiltinLanguageModel } from '../../src/sidepanel/nano/titleSynthesis';

// LIMITS: defined once, ENFORCED through the chunking path, and SHOWN.
//
// The failure this guards against is silent: a 40k-char page producing a
// two-sentence gist because 38k of it was thrown away by a `.slice()` nobody
// mentioned. So: reduction goes through planChunks (which samples the WHOLE
// document, not its head), and every reduction is reported.

const GIST =
  'CloudTrail delivers organization-wide events to a central bucket, and Athena queries them ' +
  'through partition projection. Key entities: CloudTrail, S3, Athena.';

const HEAD = 'ALPHA_MARKER the opening paragraph of the document explains the subject at length. ';
const TAIL = 'OMEGA_MARKER the closing paragraph of the document states the conclusion clearly. ';
const filler = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Body paragraph ${String(i)} carries ordinary prose words.`)
    .join('\n\n');
const LONG_DOC = `${HEAD}\n\n${filler(120)}\n\n${TAIL}`;

const chromeStub = (): void => {
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
  __resetEngineLimitsForTest();
  chromeStub();
});

afterEach(() => {
  cleanup();
  __resetEngineLimitsForTest();
  delete (globalThis as Record<string, unknown>)['chrome'];
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the limit table — one place, per MODEL for the local engine', () => {
  it('gives each engine kind its own caps', () => {
    expect(limitsFor('nano').maxInputChars).toBe(NANO_FALLBACK_MAX_INPUT_CHARS);
    // The Prompt API has no output token budget — saying null is honest.
    expect(limitsFor('nano').maxOutputTokens).toBeNull();
    expect(limitsFor('webgpu').maxInputChars).toBe(WEBGPU_1B_MAX_INPUT_CHARS);
    expect(limitsFor('remote').maxInputChars).toBe(REMOTE_MAX_INPUT_CHARS);
  });

  it('follows the SELECTED local model: the Nano-class model gets a smaller input slice', () => {
    const threeB = LOCAL_MODELS.find((m) => m.paramsBillions === 3);
    expect(threeB).toBeDefined();
    expect(limitsFor('webgpu', threeB?.id).maxInputChars).toBe(WEBGPU_3B_MAX_INPUT_CHARS);
    expect(WEBGPU_3B_MAX_INPUT_CHARS).toBeLessThan(WEBGPU_1B_MAX_INPUT_CHARS);
    // Every cap carries the derivation, so nobody "tunes" it blind later.
    expect(limitsFor('webgpu').note).toContain('2000-char inputs at ~13s');
    expect(limitsFor('webgpu', threeB?.id).note).toContain('not measured');
  });

  it('renders compactly: "limits: 2k in / 140 tok out"', () => {
    expect(formatEngineLimits(limitsFor('webgpu'))).toBe('limits: 2k in / 140 tok out');
    expect(formatEngineLimits(limitsFor('nano'))).toBe('limits: 4k in / 2k chars out');
    expect(formatEngineLimits(limitsFor('remote'))).toBe('limits: 24k in / 140 tok out');
    expect(compactCount(1800)).toBe('1.8k');
    expect(compactCount(140)).toBe('140');
    expect(formatModelSize(819_000_000)).toBe('800MB');
    expect(formatModelSize(3_300_000_000)).toBe('3.3GB');
    expect(formatModelSize(null)).toBe('unknown size');
  });
});

describe('the Nano input cap comes from the REAL quota when the browser exposes one', () => {
  it('reads inputQuota and calibrates chars-per-token with measureInputUsage', async () => {
    const destroy = vi.fn();
    const lm = {
      availability: async () => 'available',
      create: async () => ({
        inputQuota: 6144,
        measureInputUsage: async (text: string) => text.length / 5,
        prompt: async () => 'x',
        destroy,
      }),
    } as unknown as BuiltinLanguageModel;
    const limits = await probeNanoLimits(lm);
    expect(limits.inputSource).toBe('measured');
    // 6144 tokens x 5 chars/token x 0.9 headroom.
    expect(limits.maxInputChars).toBe(Math.floor(6144 * 5 * 0.9));
    expect(limits.note).toContain('Real session quota');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the documented constant when the surface is absent — guarded, never assumed', async () => {
    const lm = {
      availability: async () => 'available',
      create: async () => ({ prompt: async () => 'x', destroy: vi.fn() }),
    } as unknown as BuiltinLanguageModel;
    const limits = await probeNanoLimits(lm);
    expect(limits.inputSource).toBe('declared');
    expect(limits.maxInputChars).toBe(NANO_FALLBACK_MAX_INPUT_CHARS);
  });

  it('falls back when the API is missing or throws, rather than exploding', async () => {
    expect((await probeNanoLimits(undefined)).maxInputChars).toBe(NANO_FALLBACK_MAX_INPUT_CHARS);
    __resetEngineLimitsForTest();
    const lm = {
      availability: async () => {
        throw new Error('nope');
      },
      create: async () => ({ prompt: async () => 'x', destroy: vi.fn() }),
    } as unknown as BuiltinLanguageModel;
    expect((await probeNanoLimits(lm)).inputSource).toBe('declared');
  });
});

describe('ENFORCEMENT — over-cap input is chunked, never truncated', () => {
  it('samples the WHOLE document (head AND tail), and stays under the cap', () => {
    const prepared = prepareInput(LONG_DOC, 1200);
    expect(prepared.reduced).toBe(true);
    expect(prepared.processedChars).toBeLessThanOrEqual(1200);
    expect(prepared.processedChars).toBeLessThan(prepared.inputChars);
    // A bare `.slice(0, cap)` would keep only ALPHA. The chunking path keeps
    // the last chunk too — that is the whole difference.
    expect(prepared.text).toContain('ALPHA_MARKER');
    expect(prepared.text).toContain('OMEGA_MARKER');
    expect(LONG_DOC.startsWith(prepared.text)).toBe(false);
  });

  it('passes an under-cap document through untouched and reports no reduction', () => {
    const prepared = prepareInput('short document', 2000);
    expect(prepared.text).toBe('short document');
    expect(prepared.reduced).toBe(false);
  });

  it('synthesizeGist honors a tighter engine cap by narrowing the CHUNK width', async () => {
    const prompts: string[] = [];
    const engine = {
      kind: 'webgpu' as const,
      generate: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return prompt.startsWith(GIST_PROMPT_PREFIX)
          ? GIST
          : 'This section explains how events are delivered to a central bucket.';
      }),
    };
    const tight: EngineLimits = { ...limitsFor('webgpu'), maxInputChars: 600 };
    const outcome = await synthesizeGist(engine, LONG_DOC, tight);
    expect(outcome.ok).toBe(true);
    // Every prompt's DOCUMENT half stays under the engine's cap.
    for (const p of prompts) {
      const documentPart = p.slice(p.indexOf('\n---\n') + 5);
      expect(documentPart.length).toBeLessThanOrEqual(600 + 1);
    }
  });

  it('REPORTS the reduction in the result meta — never a silent shortfall', async () => {
    const engine = {
      kind: 'webgpu' as const,
      generate: vi.fn(async (prompt: string) =>
        prompt.startsWith(GIST_PROMPT_PREFIX)
          ? GIST
          : 'This section explains how events reach the central bucket for analysis.',
      ),
    };
    const outcome = await synthesizeGist(engine, LONG_DOC);
    expect(outcome.meta.inputChars).toBe(LONG_DOC.length);
    expect(outcome.meta.processedChars).toBeLessThan(outcome.meta.inputChars);
    expect(outcome.meta.inputReduced).toBe(true);
    expect(outcome.meta.maxInputChars).toBe(WEBGPU_1B_MAX_INPUT_CHARS);
    // …and the reduction is said out loud, in the same vocabulary as sections.
    const copy = coverageCopy(outcome.meta);
    expect(copy).toContain('sections');
    expect(copy).toContain('chars');
  });

  it('a document that fits reports no reduction at all', async () => {
    const short =
      'CloudTrail writes organization events into one central bucket. Athena queries that ' +
      'bucket with a partition projection table so scans stay cheap for a full year.';
    const engine = { kind: 'webgpu' as const, generate: vi.fn(async () => GIST) };
    const outcome = await synthesizeGist(engine, short);
    expect(outcome.meta.inputReduced).toBe(false);
    expect(coverageCopy(outcome.meta)).toBe('');
    expect(formatReduction(1800, 42_000)).toBe('1.8k/42k chars');
  });
});

describe('DISPLAY — the limits appear in BOTH rows', () => {
  const availability = (over: Partial<EngineAvailability> = {}): EngineAvailability => ({
    nanoReady: false,
    webGpuLoaded: false,
    webGpuLoading: false,
    webGpuSupported: true,
    ...over,
  });

  it('the Now card states the routed engine limits', () => {
    render(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/a' }}
        port={17_373}
        bridgeKey="k"
        availability={availability({ webGpuLoaded: true })}
        fetchText={async () => 'text'}
      />,
    );
    expect(screen.getByTestId('now-enrich-limits')).toHaveTextContent(
      'limits: 2k in / 140 tok out',
    );
  });

  it('the Now card shows nano limits when nano is the routed engine', () => {
    render(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/a' }}
        port={17_373}
        bridgeKey="k"
        availability={availability({ nanoReady: true })}
        fetchText={async () => 'text'}
      />,
    );
    expect(screen.getByTestId('now-enrich-limits')).toHaveTextContent(
      'limits: 4k in / 2k chars out',
    );
  });

  it('the Health AI row states the active engine limits', async () => {
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(),
    };
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-limits')).toHaveTextContent(
        'Nano · limits: 4k in / 2k chars out',
      );
    });
  });

  it('the Health AI row offers the model choice with its declared size, and says what is unverified', async () => {
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    const select: HTMLSelectElement = await screen.findByTestId('hp-ondevice-ai-model-select');
    expect(select.options).toHaveLength(LOCAL_MODELS.length);
    expect(select.options[0]?.textContent).toContain('1B q4 (fast)');
    expect(select.options[0]?.textContent).toContain('~800MB');
    expect(select.options[1]?.textContent).toContain('3B q4 (matched to Nano)');
    expect(select.options[1]?.textContent).toContain('~3.3GB');
    // The default is the verified one, so no "unverified" prefix up front.
    expect(screen.getByTestId('hp-ondevice-ai-model-note')).not.toHaveTextContent('unverified');
    // …but the Nano-class entry declares itself unverified rather than pretending.
    expect(localModelSpec(NANO_CLASS_LOCAL_MODEL_ID).status).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// External-data chunk count. transformers.js types use_external_data_format as
// boolean|number where `true` means EXACTLY ONE chunk. Passing `true` for a
// model whose graph is split across more shards preloads only the first and
// dies deserializing a tensor from the rest — live 2026-07-27 on the 3B:
//   Failed to load external data file "model_q4.onnx_data_1",
//   error: File not found in preloaded files.
// The shards were on disk and served fine; nothing had asked for the second.
// ---------------------------------------------------------------------------
describe('external data chunk count', () => {
  it('counts one chunk for the single-shard 1B', async () => {
    const { LOCAL_MODELS, externalDataChunkCount, DEFAULT_LOCAL_MODEL_ID } = await import(
      '../../src/sidepanel/nano/modelRegistry'
    );
    const oneB = LOCAL_MODELS.find((m) => m.id === DEFAULT_LOCAL_MODEL_ID);
    expect(oneB).toBeDefined();
    expect(externalDataChunkCount(oneB!)).toBe(1);
  });

  it('counts TWO chunks for the Nano-class 3B (the live failure)', async () => {
    const { LOCAL_MODELS, externalDataChunkCount, NANO_CLASS_LOCAL_MODEL_ID } = await import(
      '../../src/sidepanel/nano/modelRegistry'
    );
    const threeB = LOCAL_MODELS.find((m) => m.id === NANO_CLASS_LOCAL_MODEL_ID);
    expect(threeB).toBeDefined();
    expect(externalDataChunkCount(threeB!)).toBe(2);
  });

  it('counts only .onnx_data shards, never the graph or the tokenizer', async () => {
    const { externalDataChunkCount } = await import('../../src/sidepanel/nano/modelRegistry');
    const spec = {
      files: [
        'config.json',
        'tokenizer.json',
        'onnx/model_q4.onnx',
        'onnx/model_q4.onnx_data',
        'onnx/model_q4.onnx_data_1',
        'onnx/model_q4.onnx_data_2',
      ],
    } as never;
    expect(externalDataChunkCount(spec)).toBe(3);
  });

  it('every declared model has at least one shard (a zero would disable external data)', async () => {
    const { LOCAL_MODELS, externalDataChunkCount } = await import(
      '../../src/sidepanel/nano/modelRegistry'
    );
    for (const spec of LOCAL_MODELS) {
      expect(externalDataChunkCount(spec)).toBeGreaterThan(0);
    }
  });
});
