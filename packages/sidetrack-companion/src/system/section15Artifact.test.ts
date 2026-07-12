import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import { CHROME_SESSIONS_RESTORE } from './section15Events.js';
import { collectSection15Report } from './section15Collector.js';
import {
  isSection15ArtifactFresh,
  readSection15Artifact,
  writeSection15Artifact,
  SECTION15_ARTIFACT_MAX_AGE_MS,
} from './section15Artifact.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

let vaultRoot = '';

const makeEventLog = () => {
  let seq = 0;
  return createEventLog(vaultRoot, {
    replicaId: '11111111-1111-4111-8111-111111111111',
    created: true,
    nextSeq: async () => {
      seq += 1;
      return seq;
    },
    peekSeq: () => seq,
    observeSeq: async (incoming: number) => {
      seq = Math.max(seq, incoming);
    },
  });
};

let peerSeq = 0;
const peerEvent = (type: string, payload: unknown, aggregateId: string): AcceptedEvent => {
  peerSeq += 1;
  return {
    clientEventId: `peer-${type}-${String(peerSeq)}`,
    dot: { replicaId: '22222222-2222-4222-8222-222222222222', seq: peerSeq },
    deps: {},
    aggregateId,
    type,
    payload,
    acceptedAtMs: NOW.getTime(),
  };
};

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-section15-'));
  peerSeq = 0;
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

describe('collectSection15Report — typed event reads', () => {
  it('counts tab recoveries and tracked-session fraction from the event log', async () => {
    const eventLog = makeEventLog();
    await eventLog.importPeerEvent(
      peerEvent(
        BROWSER_TIMELINE_OBSERVED,
        { eventId: 'e1', tabSessionId: 'sess-1', transition: 'activated', url: 'https://a.test' },
        'timeline:sess-1',
      ),
    );
    await eventLog.importPeerEvent(
      peerEvent(
        TAB_SESSION_ATTRIBUTION_INFERRED,
        { payloadVersion: 1, tabSessionId: 'sess-1', workstreamId: 'w1' },
        'tabsession:sess-1',
      ),
    );
    await eventLog.importPeerEvent(
      peerEvent(
        CHROME_SESSIONS_RESTORE,
        { payloadVersion: 1, sessionId: 's-1', matchedOn: 'url' },
        'section15:tab-recovery',
      ),
    );

    const report = await collectSection15Report({ vaultRoot, eventLog, now: () => NOW });
    const tracked = report.criteria.find((c) => c.id === 'trackedSessionsFraction');
    const recovery = report.criteria.find((c) => c.id === 'tabRecoveries');
    expect(tracked?.value).toBe(1); // 1/1 attributed
    expect(recovery?.value).toBe(1);
    expect(recovery?.met).toBe(true);
  });

  it('reads MCP context_pack invocations from the audit jsonl', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'audit'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', 'audit', '2026-07-11.jsonl'),
      [
        JSON.stringify({ route: '/mcp', tool: 'sidetrack.search', timestamp: NOW.toISOString() }),
        JSON.stringify({
          route: '/mcp',
          tool: 'sidetrack.workstreams.context_pack',
          timestamp: NOW.toISOString(),
        }),
        // A torn/partial line must be skipped, not fatal.
        '{ this is not json',
        '',
      ].join('\n'),
      'utf8',
    );
    const eventLog = makeEventLog();
    const report = await collectSection15Report({ vaultRoot, eventLog, now: () => NOW });
    const mcp = report.criteria.find((c) => c.id === 'mcpContextPackSessions');
    expect(mcp?.value).toBe(1);
    expect(mcp?.met).toBe(true);
  });
});

describe('writeSection15Artifact — persistence + clean-days ledger', () => {
  it('round-trips through disk and reports freshness', async () => {
    const eventLog = makeEventLog();
    const written = await writeSection15Artifact({
      vaultRoot,
      eventLog,
      dataLossClean: true,
      now: () => NOW,
    });
    const read = await readSection15Artifact(vaultRoot);
    expect(read).not.toBeNull();
    expect(read?.generatedAt).toBe(NOW.toISOString());
    expect(read?.report.criteria.length).toBe(6);
    expect(written.cleanDays).toEqual([{ day: '2026-07-11', clean: true }]);
    expect(isSection15ArtifactFresh(written, () => NOW)).toBe(true);
  });

  it('accumulates a ≥7-clean-day streak ACROSS restarts (the ledger survives)', async () => {
    const days = [
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
    ];
    // Each "drain" is a fresh writeSection15Artifact call reading the
    // prior artifact off disk — exactly the restart-crossing path.
    for (const day of days) {
      const eventLog = makeEventLog();
      await writeSection15Artifact({
        vaultRoot,
        eventLog,
        dataLossClean: true,
        now: () => new Date(`${day}T23:00:00.000Z`),
      });
    }
    const read = await readSection15Artifact(vaultRoot);
    const cleanCriterion = read?.report.criteria.find((c) => c.id === 'consecutiveCleanDays');
    expect(cleanCriterion?.value).toBe(7);
    expect(cleanCriterion?.met).toBe(true);
    expect(read?.report.freezeLiftEligible).toBe(false); // other criteria unmet
  });

  it('a dirty drain-day breaks the streak on the next collect', async () => {
    for (const day of ['2026-07-08', '2026-07-09', '2026-07-10']) {
      const eventLog = makeEventLog();
      await writeSection15Artifact({
        vaultRoot,
        eventLog,
        dataLossClean: true,
        now: () => new Date(`${day}T23:00:00.000Z`),
      });
    }
    // 07-11 is dirty (a tripwire tripped).
    const dirtyLog = makeEventLog();
    await writeSection15Artifact({
      vaultRoot,
      eventLog: dirtyLog,
      dataLossClean: false,
      now: () => new Date('2026-07-11T23:00:00.000Z'),
    });
    const read = await readSection15Artifact(vaultRoot);
    const cleanCriterion = read?.report.criteria.find((c) => c.id === 'consecutiveCleanDays');
    // Latest day (07-11) is dirty ⇒ trailing streak is 0.
    expect(cleanCriterion?.value).toBe(0);
  });

  it('an artifact older than the max age is stale', () => {
    const stale = {
      schemaVersion: 1,
      generatedAt: new Date(NOW.getTime() - SECTION15_ARTIFACT_MAX_AGE_MS - 1).toISOString(),
      report: { criteria: [], freezeLiftEligible: false },
      cleanDays: [],
    };
    expect(isSection15ArtifactFresh(stale, () => NOW)).toBe(false);
  });
});

describe('readSection15Artifact — lenient parsing', () => {
  it('returns null for a missing file', async () => {
    expect(await readSection15Artifact(vaultRoot)).toBeNull();
  });

  it('returns null for a schema-version mismatch', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'system'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', 'system', 'section15.json'),
      JSON.stringify({ schemaVersion: 999, generatedAt: NOW.toISOString(), report: { criteria: [] } }),
      'utf8',
    );
    expect(await readSection15Artifact(vaultRoot)).toBeNull();
  });
});
