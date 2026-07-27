import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetWebGpuEngineForTest,
  cleanGeneratedTitle,
  enginePolicy,
  isWebGpuLoaded,
  loadWebGpuEngine,
  nanoEngineIfAvailable,
  resolveReadyEngine,
  type GenerationEngine,
  type PipelineFactory,
} from '../../src/sidepanel/nano/engine';
import type { BuiltinLanguageModel } from '../../src/sidepanel/nano/titleSynthesis';

// A LanguageModel stub whose availability + prompt are controllable per case.
const nanoLm = (availability: string, prompt = async () => 'a nano title'): BuiltinLanguageModel => ({
  availability: async () => availability,
  create: vi.fn(async () => ({ prompt, destroy: vi.fn() })),
});

// A fake transformers.js pipeline factory (the engine's test seam) so the
// WebGPU load path is exercised without pulling the lib or a GPU.
const fakePipeline = (
  generated = 'a webgpu title',
): PipelineFactory => async (onProgress) => {
  onProgress?.({ file: 'model.onnx', percent: 42 });
  return {
    generate: async () => [{ generated_text: generated }],
  };
};

beforeEach(() => {
  __resetWebGpuEngineForTest();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

afterEach(() => {
  __resetWebGpuEngineForTest();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.restoreAllMocks();
});

describe('cleanGeneratedTitle', () => {
  it('strips surrounding markdown asterisks and quotes', () => {
    expect(cleanGeneratedTitle('**CloudTrail log analysis**')).toBe('CloudTrail log analysis');
    expect(cleanGeneratedTitle('"A quoted title"')).toBe('A quoted title');
    expect(cleanGeneratedTitle('  “smart quotes”  ')).toBe('smart quotes');
  });

  it('removes inner ** emphasis and caps at 200 chars', () => {
    expect(cleanGeneratedTitle('The **key** term')).toBe('The key term');
    expect(cleanGeneratedTitle('x'.repeat(300))).toHaveLength(200);
  });
});

describe('enginePolicy — never auto-loads; nano preferred; webgpu only after explicit load', () => {
  it('returns none when neither engine is ready', async () => {
    expect(await enginePolicy(undefined)).toBe('none');
  });

  it('prefers nano when the built-in API is available', async () => {
    expect(await enginePolicy(nanoLm('available'))).toBe('nano');
  });

  it('does NOT treat a non-available nano as ready', async () => {
    expect(await enginePolicy(nanoLm('downloadable'))).toBe('none');
    expect(await enginePolicy(nanoLm('unavailable'))).toBe('none');
  });

  it('reports webgpu ONLY after an explicit loadWebGpuEngine — never as a side effect', async () => {
    // No load yet: policy is none, resolveReadyEngine yields null (no generate).
    expect(isWebGpuLoaded()).toBe(false);
    expect(await enginePolicy(undefined)).toBe('none');
    expect(await resolveReadyEngine(undefined)).toBeNull();

    // Explicit load with the injected factory — the ONLY path that "loads".
    const engine = await loadWebGpuEngine({ port: 17_373, pipelineFactory: fakePipeline() });
    expect(engine.kind).toBe('webgpu');
    expect(isWebGpuLoaded()).toBe(true);
    // Now — and only now — policy reports webgpu and resolve returns it.
    expect(await enginePolicy(undefined)).toBe('webgpu');
    const ready = await resolveReadyEngine(undefined);
    expect(ready?.kind).toBe('webgpu');
  });

  it('nano still wins over a loaded webgpu (cheaper, resident)', async () => {
    await loadWebGpuEngine({ port: 17_373, pipelineFactory: fakePipeline() });
    expect(await enginePolicy(nanoLm('available'))).toBe('nano');
    expect((await resolveReadyEngine(nanoLm('available')))?.kind).toBe('nano');
  });
});

describe('loadWebGpuEngine — explicit-load gating', () => {
  it('is the only trigger for the pipeline; the factory runs exactly once and reports progress', async () => {
    const factory = vi.fn(fakePipeline());
    const progress: number[] = [];
    const engine = await loadWebGpuEngine({
      port: 17_373,
      pipelineFactory: factory,
      onProgress: (p) => progress.push(p.percent),
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(progress).toContain(42);
    // Idempotent — a repeat load reuses the singleton, no second factory call.
    const again = await loadWebGpuEngine({ port: 17_373, pipelineFactory: factory });
    expect(again).toBe(engine);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('cleans the generated title (strips markdown wrapping the model adds)', async () => {
    const engine = await loadWebGpuEngine({
      port: 17_373,
      pipelineFactory: fakePipeline('**wrapped title**'),
    });
    const out = await engine.generate('prompt', { maxNewTokens: 24 });
    expect(out).toBe('wrapped title');
  });
});

describe('nanoEngineIfAvailable', () => {
  it('returns null unless availability is exactly available', async () => {
    expect(await nanoEngineIfAvailable(undefined)).toBeNull();
    expect(await nanoEngineIfAvailable(nanoLm('downloadable'))).toBeNull();
    const engine = await nanoEngineIfAvailable(nanoLm('available'));
    expect(engine?.kind).toBe('nano');
  });

  it('generate() cleans the nano output', async () => {
    const engine = (await nanoEngineIfAvailable(
      nanoLm('available', async () => '"a nano title"'),
    )) as GenerationEngine;
    expect(await engine.generate('p', { maxNewTokens: 24 })).toBe('a nano title');
  });
});
