import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { runEventSealPass, sealSegmentPath } from './eventSeal.js';
import { runSealIntegrityCheck } from './eventScan.js';

const PEER = 'peer-scan-integrity';
const DAY_A = '2026-03-01';
const DAY_B = '2026-03-02';
const NOW = new Date('2026-03-04T12:00:00.000Z');

const peerEvent = (seq: number, day: string): AcceptedEvent => ({
  clientEventId: `${PEER}.${String(seq)}.thread.upserted`,
  dot: { replicaId: PEER, seq },
  deps: {},
  aggregateId: `T${String(seq)}`,
  type: 'thread.upserted',
  payload: { bac_id: `T${String(seq)}`, title: `Thread ${String(seq)}` },
  acceptedAtMs: Date.parse(`${day}T10:00:00.000Z`) + seq,
});

describe('seal integrity check', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-scan-'));
    previousStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    previousSealFlag = process.env['SIDETRACK_EVENT_SEAL'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_EVENT_SEAL'] = '1';
  });

  afterEach(async () => {
    if (previousStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousStoreFlag;
    if (previousSealFlag === undefined) delete process.env['SIDETRACK_EVENT_SEAL'];
    else process.env['SIDETRACK_EVENT_SEAL'] = previousSealFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const seedAndSeal = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 5; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    for (let seq = 6; seq <= 9; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_B));
    const pass = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(pass.errors).toEqual([]);
    expect(pass.sealed).toHaveLength(2);
  };

  it('reports all-match on a freshly sealed vault', async () => {
    await seedAndSeal();
    const report = await runSealIntegrityCheck(vaultRoot, { now: () => NOW });
    expect(report).not.toBeNull();
    expect(report).toMatchObject({
      checkedDays: 2,
      matches: 2,
      storeDrift: 0,
      segmentAlarms: [],
    });
  });

  it('classifies a late arrival as benign store-drift, healed by re-sealing', async () => {
    await seedAndSeal();
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent(10, DAY_A));

    const drifted = await runSealIntegrityCheck(vaultRoot, { now: () => NOW });
    expect(drifted).toMatchObject({ matches: 1, storeDrift: 1, segmentAlarms: [] });

    await runEventSealPass(vaultRoot, { now: () => NOW });
    const healed = await runSealIntegrityCheck(vaultRoot, { now: () => NOW });
    expect(healed).toMatchObject({ matches: 2, storeDrift: 0, segmentAlarms: [] });
  });

  it('raises a segment alarm when a sealed file is tampered with', async () => {
    await seedAndSeal();
    // Overwrite DAY_A's segment with garbage — read_parquet yields no rows.
    await writeFile(sealSegmentPath(vaultRoot, PEER, DAY_A), 'not parquet');
    const report = await runSealIntegrityCheck(vaultRoot, { now: () => NOW });
    expect(report?.segmentAlarms).toHaveLength(1);
    expect(report?.segmentAlarms[0]).toMatchObject({ replica: PEER, day: DAY_A });
    expect(report?.matches).toBe(1);
  });

  it('raises a segment-missing alarm when a sealed file is deleted', async () => {
    await seedAndSeal();
    await unlink(sealSegmentPath(vaultRoot, PEER, DAY_B));
    const report = await runSealIntegrityCheck(vaultRoot, { now: () => NOW });
    expect(report?.segmentAlarms).toHaveLength(1);
    expect(report?.segmentAlarms[0]).toMatchObject({
      replica: PEER,
      day: DAY_B,
      verdict: 'segment-missing',
    });
  });

  it('returns null when the tier is off or nothing is sealed', async () => {
    delete process.env['SIDETRACK_EVENT_SEAL'];
    expect(await runSealIntegrityCheck(vaultRoot)).toBeNull();
    process.env['SIDETRACK_EVENT_SEAL'] = '1';
    expect(await runSealIntegrityCheck(vaultRoot)).toBeNull();
  });
});
