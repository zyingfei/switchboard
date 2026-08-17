import { describe, expect, it } from 'vitest';

import {
  MIN_EVIDENCE_FOR_GENERATION,
  PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
  type WorkstreamGenerationState,
} from './prototypeGeneration.js';
import { computeWorkstreamPrototypeStatus } from './prototypeStatus.js';

const generation = (over: Partial<WorkstreamGenerationState> = {}): WorkstreamGenerationState => ({
  workstreamId: 'ws-1',
  evidenceWatermark: '5:abc123',
  generatedAt: 1_700_000_000_000,
  generatorModelId: 'apple-fm#reason=ok',
  method: 'generated',
  prototypeIds: ['proto-1', 'proto-2', 'proto-3'],
  embeddingSchemaVersion: PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
  ...over,
});

describe('computeWorkstreamPrototypeStatus', () => {
  it('below the evidence floor: honest whyNot names the exact count', () => {
    const status = computeWorkstreamPrototypeStatus('ws-1', 2, true, undefined, {
      available: true,
      reason: 'ok',
    });
    expect(status.prototypeCount).toBe(0);
    expect(status.whyNot).toBe(
      `needs ${String(MIN_EVIDENCE_FOR_GENERATION)}+ saved pages, has 2`,
    );
    expect(status.whyNotDetail).toBeNull();
  });

  it('above the floor, English corpus, Apple FM unavailable: names the engine + probe reason', () => {
    const status = computeWorkstreamPrototypeStatus('ws-1', 8, true, undefined, {
      available: false,
      reason: 'not-running',
    });
    expect(status.whyNot).toBe('Apple Intelligence engine unavailable');
    expect(status.whyNotDetail).toContain('apfel --serve');
  });

  it('above the floor, English corpus, appleFm status undefined (probe failed to even run): no detail crash', () => {
    const status = computeWorkstreamPrototypeStatus('ws-1', 8, true, undefined, undefined);
    expect(status.whyNot).toBe('Apple Intelligence engine unavailable');
    expect(status.whyNotDetail).toBeNull();
  });

  it('above the floor, non-English corpus: never blames the engine — pending instead', () => {
    const status = computeWorkstreamPrototypeStatus('ws-1', 8, false, undefined, {
      available: false,
      reason: 'not-running',
    });
    expect(status.whyNot).toBe('generation pending — runs in the background');
  });

  it('above the floor, engine available, nothing generated yet: pending', () => {
    const status = computeWorkstreamPrototypeStatus('ws-1', 8, true, undefined, {
      available: true,
      reason: 'ok',
    });
    expect(status.whyNot).toBe('generation pending — runs in the background');
  });

  it('a generated batch reports counts/engine/label and no whyNot', () => {
    const status = computeWorkstreamPrototypeStatus(
      'ws-1',
      12,
      true,
      generation(),
      { available: true, reason: 'ok' },
    );
    expect(status.prototypeCount).toBe(3);
    expect(status.generatedAt).toBe(1_700_000_000_000);
    expect(status.evidenceCount).toBe(12);
    expect(status.engine).toBe('apple-fm#reason=ok');
    expect(status.engineLabel).toBe('Apple Intelligence');
    expect(status.method).toBe('generated');
    expect(status.methodNote).toBeNull();
    expect(status.whyNot).toBeNull();
    expect(status.whyNotDetail).toBeNull();
  });

  it('a "selected" zh-reason batch surfaces the zh methodNote and real-excerpt engine label', () => {
    const status = computeWorkstreamPrototypeStatus(
      'ws-1',
      12,
      false,
      generation({ generatorModelId: 'evidence-selection#reason=zh', method: 'selected' }),
      undefined,
    );
    expect(status.engineLabel).toBe('real page excerpts (no generation)');
    expect(status.method).toBe('selected');
    expect(status.methodNote).toBe(
      'Chinese-language pages: matching uses real excerpts instead of generated text',
    );
  });

  it('a "selected" mixed-en-zh reason batch surfaces the mixed methodNote', () => {
    const status = computeWorkstreamPrototypeStatus(
      'ws-1',
      12,
      false,
      generation({ generatorModelId: 'evidence-selection#reason=mixed-en-zh', method: 'selected' }),
      undefined,
    );
    expect(status.methodNote).toBe(
      'Mixed-language pages: matching uses real excerpts instead of generated text',
    );
  });

  it('a "selected" batch with an unrecognized reason falls back to the generic methodNote', () => {
    const status = computeWorkstreamPrototypeStatus(
      'ws-1',
      12,
      false,
      generation({ generatorModelId: 'evidence-selection#reason=other', method: 'selected' }),
      undefined,
    );
    expect(status.methodNote).toBe('matching uses real excerpts instead of generated text');
  });

  it('an unrecognized generatorModelId passes through as its own label', () => {
    const status = computeWorkstreamPrototypeStatus(
      'ws-1',
      12,
      true,
      generation({ generatorModelId: 'some-future-engine#v2' }),
      undefined,
    );
    expect(status.engineLabel).toBe('some-future-engine#v2');
  });
});
