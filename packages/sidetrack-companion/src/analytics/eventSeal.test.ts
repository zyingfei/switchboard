import { mkdtemp, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  eventSealEnabled,
  readSealManifest,
  runEventSealPass,
  sealManifestPath,
  sealSegmentPath,
} from './eventSeal.js';

const PEER = 'peer-columnar-seal';

// Fixed, closed UTC days. `now` is pinned two days after DAY_B so both days
// are strictly in the past and the "today" exclusion is exercised with a
// deterministic clock.
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

describe('columnar event sealer', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-seal-'));
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

  const seedTwoClosedDays = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 5; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    for (let seq = 6; seq <= 9; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_B));
  };

  it('flag reader follows the default-off idiom', () => {
    expect(eventSealEnabled()).toBe(true);
    process.env['SIDETRACK_EVENT_SEAL'] = 'true';
    expect(eventSealEnabled()).toBe(false);
    delete process.env['SIDETRACK_EVENT_SEAL'];
    expect(eventSealEnabled()).toBe(false);
  });

  it('seals closed days, verifies, and records manifest entries', async () => {
    await seedTwoClosedDays();
    const result = await runEventSealPass(vaultRoot, { now: () => NOW });

    expect(result.errors).toEqual([]);
    expect(result.sealed.map((entry) => entry.day).sort()).toEqual([DAY_A, DAY_B]);
    const dayA = result.sealed.find((entry) => entry.day === DAY_A);
    expect(dayA).toMatchObject({ replica: PEER, rows: 5, seqLo: 1, seqHi: 5 });
    expect(dayA?.sha256).toMatch(/^[0-9a-f]{64}$/);

    for (const day of [DAY_A, DAY_B]) {
      const info = await stat(sealSegmentPath(vaultRoot, PEER, day));
      expect(info.size).toBeGreaterThan(0);
    }
    const manifest = await readSealManifest(vaultRoot);
    expect(manifest.lines).toBe(2);
    expect(manifest.malformedLines).toBe(0);
    expect(manifest.latest.get(`${PEER} ${DAY_B}`)).toMatchObject({ rows: 4, seqLo: 6, seqHi: 9 });
  });

  it('is idempotent: a second pass seals nothing', async () => {
    await seedTwoClosedDays();
    await runEventSealPass(vaultRoot, { now: () => NOW });
    const second = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(second.sealed).toEqual([]);
    expect(second.planned).toEqual([]);
    expect(second.skippedAlreadySealed).toBe(2);
    expect(second.errors).toEqual([]);
  });

  it('never seals an open (today or future-dated) day', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent(1, DAY_A));
    // Same-day and fast-clock peer events, relative to the pinned NOW.
    await eventLog.importPeerEvent(peerEvent(2, '2026-03-04'));
    await eventLog.importPeerEvent(peerEvent(3, '2026-03-05'));

    const result = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(result.sealed.map((entry) => entry.day)).toEqual([DAY_A]);
    expect(result.skippedOpenDays).toBe(2);
  });

  it('re-seals a day when a late peer arrival changes its retained set', async () => {
    await seedTwoClosedDays();
    await runEventSealPass(vaultRoot, { now: () => NOW });

    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent(10, DAY_A));

    const result = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(result.errors).toEqual([]);
    expect(result.sealed.map((entry) => entry.day)).toEqual([DAY_A]);
    const manifest = await readSealManifest(vaultRoot);
    // Superseding line appended; latest wins.
    expect(manifest.lines).toBe(3);
    expect(manifest.latest.get(`${PEER} ${DAY_A}`)).toMatchObject({
      rows: 6,
      seqLo: 1,
      seqHi: 10,
    });
  });

  it('dry-run plans without writing anything', async () => {
    await seedTwoClosedDays();
    const result = await runEventSealPass(vaultRoot, { dryRun: true, now: () => NOW });
    expect(result.planned.map((entry) => entry.day).sort()).toEqual([DAY_A, DAY_B]);
    expect(result.sealed).toEqual([]);
    await expect(stat(sealSegmentPath(vaultRoot, PEER, DAY_A))).rejects.toThrow();
    await expect(stat(sealManifestPath(vaultRoot))).rejects.toThrow();
  });

  it('manifest read is malformed-line tolerant and last-entry-wins', async () => {
    await seedTwoClosedDays();
    await runEventSealPass(vaultRoot, { now: () => NOW });
    await appendFile(sealManifestPath(vaultRoot), 'not json\n{"half":true}\n');
    const manifest = await readSealManifest(vaultRoot);
    expect(manifest.malformedLines).toBe(2);
    expect(manifest.latest.size).toBe(2);
    const raw = await readFile(sealManifestPath(vaultRoot), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});
