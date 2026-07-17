import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatPrequentialEvalRunResult,
  runAttributionPrequentialEval,
} from './cli.js';
import {
  ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION,
  attributionPrequentialVerdictPath,
} from './verdictArtifact.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';

let seq = 0;
const timelineEvent = (url: string, title: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `tl-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `timeline:${url}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `evt-${seq}`,
      observedAt: new Date(atMs).toISOString(),
      url,
      canonicalUrl: url,
      title,
      transition: 'activated',
    },
    acceptedAtMs: atMs,
  };
};
const organizeEvent = (url: string, ws: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `org-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `canonical-url:${url}`,
    type: USER_ORGANIZED_ITEM,
    payload: { payloadVersion: 1, itemKind: 'canonical-url', itemId: url, action: 'move', toContainer: ws },
    acceptedAtMs: atMs,
  };
};

const fixtureEvents = (): readonly AcceptedEvent[] => {
  seq = 0;
  return [
    timelineEvent('https://a.example/1', 'alpha alpha topic', 1),
    timelineEvent('https://b.example/1', 'alpha alpha topic', 2),
    organizeEvent('https://a.example/1', 'wsX', 10),
    organizeEvent('https://b.example/1', 'wsX', 11),
  ];
};

describe('runAttributionPrequentialEval', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'attr-preq-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('runs the replay with an injected reader and returns the verdict', async () => {
    const result = await runAttributionPrequentialEval(vaultRoot, {
      persist: false,
      readEvents: async () => fixtureEvents(),
    });
    expect(result.report.labelCount).toBe(2);
    expect(result.artifact.schemaVersion).toBe(ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION);
    expect(result.artifact.reportOnly).toBe(true);
    // No persist ⇒ no path.
    expect(result.artifactPath).toBeNull();
    // The CLI format string carries the table + verdict.
    const text = formatPrequentialEvalRunResult(result);
    expect(text).toContain('prequential replay');
    expect(text).toContain('VERDICT:');
  });

  it('persists the verdict artifact under _BAC/eval/ when persist is not disabled', async () => {
    const result = await runAttributionPrequentialEval(vaultRoot, {
      readEvents: async () => fixtureEvents(),
      generatedAt: 123456,
    });
    expect(result.artifactPath).toBe(attributionPrequentialVerdictPath(vaultRoot));
    const onDisk = JSON.parse(await readFile(attributionPrequentialVerdictPath(vaultRoot), 'utf8')) as {
      schemaVersion: number;
      generatedAt: number;
      labelCount: number;
      reportOnly: boolean;
    };
    expect(onDisk.schemaVersion).toBe(ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION);
    expect(onDisk.generatedAt).toBe(123456);
    expect(onDisk.labelCount).toBe(2);
    expect(onDisk.reportOnly).toBe(true);
  });
});
