import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  resetShadowStateMemoForTest,
  titleForCanonicalUrl,
} from './emit.js';
import {
  ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION,
  attributionV1ArtifactPath,
} from './artifact.js';
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
        // The title is looked up lazily from the snapshot INSIDE emit (only
        // past the flag + fresh-state gates); with no artifact this is a no-op
        // and the snapshot is never scanned.
        snapshot: { nodes: [{ metadata: { canonicalUrl: 'https://a.com', title: 'anything' } }] },
        incumbentTop: 'ws-x',
      }),
    ).resolves.toBeUndefined();
    expect(peekShadowBufferSize()).toBe(0);
  });
});

// Findings 1 (memoize the 105KB parse on mtime) and 3 (title lookup runs
// lazily behind the flag + state gates, so it never scans the snapshot on the
// serve path when the shadow lane is off / has no state).
describe('emitAttributionV1Shadow load memo + lazy title', () => {
  let vaultRoot: string;
  const priorFlag = process.env[ATTRIBUTION_V1_SHADOW_ENV];

  // A snapshot whose `nodes` throws if anyone iterates it — proves the title
  // lookup did NOT run (the O(nodes) scan is gated).
  const trapSnapshot = {
    get nodes(): never {
      throw new Error('snapshot.nodes was scanned — the title lookup was not gated');
    },
  } as unknown as Parameters<typeof titleForCanonicalUrl>[0];

  const oneLabelState = {
    workstreams: {
      'ws-shadow': { termDocFreq: { kubernetes: 1 }, memberCount: 1, labelCount: 30 },
    },
    globalTermWorkstreamFreq: { kubernetes: 1 },
    domains: {},
    lastFiledWorkstreamId: 'ws-shadow',
    lastFiledAtMs: 1,
    totalLabelCount: 1,
    totalMemberCount: 1,
  };
  const writeArtifact = async (generatedAt: string): Promise<void> => {
    const path = attributionV1ArtifactPath(vaultRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: ATTRIBUTION_V1_ARTIFACT_SCHEMA_VERSION,
        generatedAt,
        state: oneLabelState,
      }),
      'utf8',
    );
  };

  beforeEach(async () => {
    resetShadowBufferForTest();
    resetShadowStateMemoForTest();
    vaultRoot = await mkdtemp(join(tmpdir(), 'attrib-v1-memo-'));
  });
  afterEach(async () => {
    resetShadowStateMemoForTest();
    if (priorFlag === undefined) delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    else process.env[ATTRIBUTION_V1_SHADOW_ENV] = priorFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('never scans the snapshot when the flag is off (title lookup is gated)', async () => {
    process.env[ATTRIBUTION_V1_SHADOW_ENV] = '0';
    await writeArtifact(new Date().toISOString());
    // trapSnapshot.nodes throws if touched; the flag gate must short-circuit
    // before the title lookup, so this resolves without throwing.
    await expect(
      emitAttributionV1Shadow({
        vaultRoot,
        canonicalUrl: 'https://a.com',
        snapshot: trapSnapshot,
        incumbentTop: null,
      }),
    ).resolves.toBeUndefined();
    expect(peekShadowBufferSize()).toBe(0);
  });

  it('never scans the snapshot when there is no fresh state (gated after the state read)', async () => {
    delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    // No artifact written ⇒ loadStateForShadow returns null before the title
    // lookup, so the trap snapshot is never scanned.
    await expect(
      emitAttributionV1Shadow({
        vaultRoot,
        canonicalUrl: 'https://a.com',
        snapshot: trapSnapshot,
        incumbentTop: null,
      }),
    ).resolves.toBeUndefined();
    expect(peekShadowBufferSize()).toBe(0);
  });

  it('records once the flag + fresh state pass, scanning the snapshot exactly then', async () => {
    delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    await writeArtifact(new Date().toISOString());
    let scans = 0;
    const countingSnapshot = {
      get nodes(): { metadata: { canonicalUrl: string; title: string } }[] {
        scans += 1;
        return [{ metadata: { canonicalUrl: 'https://a.com', title: 'kubernetes deploy' } }];
      },
    } as unknown as Parameters<typeof titleForCanonicalUrl>[0];
    await emitAttributionV1Shadow({
      vaultRoot,
      canonicalUrl: 'https://a.com',
      snapshot: countingSnapshot,
      incumbentTop: null,
    });
    // The O(nodes) scan happened exactly once (not twice, as the old server
    // call site did), and a shadow record was produced.
    expect(scans).toBe(1);
    expect(peekShadowBufferSize()).toBe(1);
  });

  it('reloads the state only when the artifact mtime changes (finding 1 memo)', async () => {
    delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    // A fresh generatedAt so the 24h age gate passes.
    await writeArtifact(new Date().toISOString());
    const snapshot = {
      nodes: [{ metadata: { canonicalUrl: 'https://a.com', title: 'kubernetes deploy' } }],
    };
    // First call loads + parses; subsequent calls with the SAME file hit the
    // mtime memo and must not re-read. We can't observe the read directly, but
    // we can prove correctness across a real artifact rewrite: rewrite with a
    // new generatedAt (which changes the mtime) and confirm the reload path
    // still serves a valid record rather than a stale/empty one.
    for (let i = 0; i < 3; i += 1) {
      await emitAttributionV1Shadow({
        vaultRoot,
        canonicalUrl: 'https://a.com',
        snapshot,
        incumbentTop: null,
      });
    }
    expect(peekShadowBufferSize()).toBe(3);
    // Rewrite the artifact (mtime advances) — the memo must invalidate and the
    // next call must still record from the fresh file.
    resetShadowBufferForTest();
    await new Promise((r) => setTimeout(r, 5));
    await writeArtifact(new Date().toISOString());
    await emitAttributionV1Shadow({
      vaultRoot,
      canonicalUrl: 'https://a.com',
      snapshot,
      incumbentTop: null,
    });
    expect(peekShadowBufferSize()).toBe(1);
  });
});
