import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_V1_SHADOW_ENV,
  attributionV1ShadowEnabled,
  attributionV1ShadowLogPath,
  buildShadowRecord,
  drainShadowBuffer,
  flushShadowBuffer,
  peekShadowBufferSize,
  recordShadowObservation,
  resetShadowBufferForTest,
} from './shadow.js';
import {
  emitAttributionV1Shadow,
  incumbentTopFromResolution,
  titleForCanonicalUrl,
} from './emit.js';
import type { AttributionV1Result } from './scorer.js';

const suggestResult = (workstreamId: string): AttributionV1Result => ({
  action: 'suggest',
  candidates: [
    {
      workstreamId,
      score: 1,
      contributions: { titleLexical: 1, conditionalDomain: 0, recency: 0 },
      reasons: [],
      shrunkPrecision: 0.5,
      labelCount: 30,
    },
  ],
});
const abstainResult = (): AttributionV1Result => ({ action: 'abstain', candidates: [] });

describe('attributionV1ShadowEnabled (default ON)', () => {
  const prior = process.env[ATTRIBUTION_V1_SHADOW_ENV];
  afterEach(() => {
    if (prior === undefined) delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    else process.env[ATTRIBUTION_V1_SHADOW_ENV] = prior;
  });
  it('is enabled when the env var is absent', () => {
    delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    expect(attributionV1ShadowEnabled()).toBe(true);
  });
  it('is enabled when the env var is any non-"0" value', () => {
    process.env[ATTRIBUTION_V1_SHADOW_ENV] = '1';
    expect(attributionV1ShadowEnabled()).toBe(true);
  });
  it('is disabled only when explicitly "0"', () => {
    process.env[ATTRIBUTION_V1_SHADOW_ENV] = '0';
    expect(attributionV1ShadowEnabled()).toBe(false);
  });
});

describe('buildShadowRecord agreement', () => {
  it('agrees when both name the same workstream', () => {
    const record = buildShadowRecord({
      url: 'https://a.com',
      ts: 100,
      incumbentTop: 'ws-x',
      v1: suggestResult('ws-x'),
    });
    expect(record.v1Top).toBe('ws-x');
    expect(record.agree).toBe(true);
    expect(record.v1Action).toBe('suggest');
  });
  it('disagrees when they name different workstreams', () => {
    const record = buildShadowRecord({
      url: 'https://a.com',
      ts: 100,
      incumbentTop: 'ws-x',
      v1: suggestResult('ws-y'),
    });
    expect(record.agree).toBe(false);
  });
  it('agrees when both abstain (null == null)', () => {
    const record = buildShadowRecord({
      url: 'https://a.com',
      ts: 100,
      incumbentTop: null,
      v1: abstainResult(),
    });
    expect(record.v1Top).toBeNull();
    expect(record.agree).toBe(true);
    expect(record.v1Action).toBe('abstain');
  });
  it('disagrees when incumbent picks and v1 abstains', () => {
    const record = buildShadowRecord({
      url: 'https://a.com',
      ts: 100,
      incumbentTop: 'ws-x',
      v1: abstainResult(),
    });
    expect(record.agree).toBe(false);
  });
});

describe('incumbentTopFromResolution', () => {
  it('returns the workstream on a suggest decision', () => {
    expect(
      incumbentTopFromResolution({ decision: { action: 'suggest', workstreamId: 'ws-a' } }),
    ).toBe('ws-a');
  });
  it('returns null on an inbox (abstention) decision', () => {
    expect(
      incumbentTopFromResolution({ decision: { action: 'inbox', workstreamId: 'ws-a' } }),
    ).toBeNull();
  });
  it('returns null when no workstream decided', () => {
    expect(incumbentTopFromResolution({ decision: { action: 'inbox' } })).toBeNull();
  });
});

describe('titleForCanonicalUrl', () => {
  it('prefers metadata.title of the matching node', () => {
    const snapshot = {
      nodes: [
        { label: 'label-a', metadata: { canonicalUrl: 'https://a.com', title: 'Real Title' } },
      ],
    };
    expect(titleForCanonicalUrl(snapshot, 'https://a.com')).toBe('Real Title');
  });
  it('falls back to the node label when no title', () => {
    const snapshot = {
      nodes: [{ label: 'Label Fallback', metadata: { canonicalUrl: 'https://a.com' } }],
    };
    expect(titleForCanonicalUrl(snapshot, 'https://a.com')).toBe('Label Fallback');
  });
  it('returns undefined when no node matches', () => {
    const snapshot = { nodes: [{ label: 'x', metadata: { canonicalUrl: 'https://other' } }] };
    expect(titleForCanonicalUrl(snapshot, 'https://a.com')).toBeUndefined();
  });
});

describe('shadow ring buffer', () => {
  beforeEach(() => resetShadowBufferForTest());
  it('accumulates records and drains them (clearing the buffer)', () => {
    recordShadowObservation(
      buildShadowRecord({ url: 'https://a', ts: 1, incumbentTop: null, v1: abstainResult() }),
    );
    recordShadowObservation(
      buildShadowRecord({ url: 'https://b', ts: 2, incumbentTop: 'w', v1: suggestResult('w') }),
    );
    expect(peekShadowBufferSize()).toBe(2);
    const drained = drainShadowBuffer();
    expect(drained.length).toBe(2);
    expect(peekShadowBufferSize()).toBe(0);
  });
});

describe('flushShadowBuffer', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    resetShadowBufferForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'attrib-v1-shadow-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });
  it('appends buffered records to the JSONL log and clears the buffer', async () => {
    recordShadowObservation(
      buildShadowRecord({ url: 'https://a', ts: 1, incumbentTop: 'w', v1: suggestResult('w') }),
    );
    const flushed = await flushShadowBuffer(vaultRoot);
    expect(flushed).toBe(1);
    expect(peekShadowBufferSize()).toBe(0);
    const body = await readFile(attributionV1ShadowLogPath(vaultRoot), 'utf8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ url: 'https://a', v1Top: 'w', agree: true });
  });
  it('flushes nothing when the buffer is empty', async () => {
    expect(await flushShadowBuffer(vaultRoot)).toBe(0);
  });
});

describe('emitAttributionV1Shadow is a safe no-op when no state artifact exists', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    resetShadowBufferForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'attrib-v1-emit-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });
  it('records nothing and does not throw when the artifact is absent', async () => {
    await expect(
      emitAttributionV1Shadow({
        vaultRoot,
        canonicalUrl: 'https://a.com',
        title: 'anything',
        incumbentTop: 'ws-x',
      }),
    ).resolves.toBeUndefined();
    expect(peekShadowBufferSize()).toBe(0);
  });
});
