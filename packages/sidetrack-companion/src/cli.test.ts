import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { companionVersion, renderServiceNextSteps, runCli } from './cli.js';

class MemoryWritable extends Writable {
  private chunks = '';

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks += chunk.toString();
    callback();
  }

  text(): string {
    return this.chunks;
  }
}

const createStreams = (): { readonly stdout: MemoryWritable; readonly stderr: MemoryWritable } => ({
  stdout: new MemoryWritable(),
  stderr: new MemoryWritable(),
});

describe('runCli', () => {
  it('prints the package version', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['--version'], streams);

    expect(exitCode).toBe(0);
    expect(streams.stdout.text()).toBe(`${companionVersion}\n`);
    expect(streams.stderr.text()).toBe('');
  });

  it('prints help without starting the API runtime', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['--help'], streams);

    expect(exitCode).toBe(0);
    expect(streams.stdout.text()).toContain('sidetrack-companion');
    expect(streams.stdout.text()).toContain('--vault <path>');
    expect(streams.stderr.text()).toBe('');
  });

  it('rejects startup without a vault path', async () => {
    const streams = createStreams();

    const exitCode = await runCli([], streams);

    expect(exitCode).toBe(2);
    expect(streams.stderr.text()).toContain('Missing required --vault <path>.');
  });

  it('models status reports the manifest revision + cache dir without touching the network', async () => {
    const streams = createStreams();
    const exitCode = await runCli(
      ['models', 'status', '--models-dir', '/tmp/sb-models-test', '--offline-models'],
      streams,
    );
    expect(exitCode).toBe(0);
    const out = streams.stdout.text();
    expect(out).toContain('model id');
    expect(out).toContain('Xenova/multilingual-e5-small');
    expect(out).toContain('cache dir    /tmp/sb-models-test');
    expect(out).toContain('present      no');
    // Verified line should reflect the actual cause. With no model
    // on disk it must say "model not present", NOT the legacy
    // "revision unpinned" string that survived the manifest-pinning
    // commit.
    expect(out).toContain('verified     no (model not present)');
    expect(out).not.toContain('revision unpinned');
  });

  it('models status --json produces machine-readable output', async () => {
    const streams = createStreams();
    const exitCode = await runCli(
      ['models', 'status', '--models-dir', '/tmp/sb-models-test', '--offline-models', '--json'],
      streams,
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(streams.stdout.text()) as Record<string, unknown>;
    expect(parsed['modelId']).toBe('Xenova/multilingual-e5-small');
    expect(parsed['cacheDir']).toBe('/tmp/sb-models-test');
    expect(parsed['offline']).toBe(true);
  });

  it('models with no verb prints usage and exits 2', async () => {
    const streams = createStreams();
    const exitCode = await runCli(['models'], streams);
    expect(exitCode).toBe(2);
    expect(streams.stdout.text()).toContain('Usage: sidetrack-companion models');
  });

  it('--models-dir + --offline-models on the runtime path are accepted (help still renders)', async () => {
    // Smoke: the flags don't crash parseArgs and the help text
    // advertises them. We can't fully boot the runtime in a unit
    // test (no vault wiring), but the parser+help surface is the
    // contract we want to lock down.
    const streams = createStreams();
    const exitCode = await runCli(['--help'], streams);
    expect(exitCode).toBe(0);
    expect(streams.stdout.text()).toContain('--models-dir');
    expect(streams.stdout.text()).toContain('--offline-models');
  });

  it('models verify on an empty cache returns 1 with a clear hint', async () => {
    const streams = createStreams();
    const exitCode = await runCli(
      ['models', 'verify', '--models-dir', '/tmp/sb-models-empty', '--offline-models'],
      streams,
    );
    expect(exitCode).toBe(1);
    expect(streams.stderr.text()).toContain('model not present');
  });

  it('ingest --import imports edge-origin events idempotently (gate L3-G7)', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ingest-test-'));
    try {
      // Two valid edge-origin AcceptedEvents serialized as JSONL.
      // Sync Contract v1 / Class F: edge dot is canonical identity;
      // re-importing the same archive twice produces no duplicates.
      const archivePath = join(vaultRoot, 'archive.jsonl');
      const events = [
        {
          clientEventId: 'ed-1',
          dot: { replicaId: 'edge_test_abc', seq: 1 },
          deps: {},
          aggregateId: 'th-imported',
          type: 'thread.upserted',
          payload: {
            bac_id: 'th-imported',
            provider: 'chatgpt',
            threadUrl: 'https://x',
            title: 'Imported',
            lastSeenAt: '2026-05-07T00:00:00.000Z',
          },
          acceptedAtMs: 1,
        },
      ];
      await writeFile(archivePath, events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
      const streams1 = createStreams();
      const exit1 = await runCli(
        ['ingest', '--import', archivePath, '--vault', vaultRoot],
        streams1,
      );
      expect(exit1).toBe(0);
      expect(streams1.stdout.text()).toContain('imported=1');
      // Second import: same edge dots → all skipped (idempotent).
      const streams2 = createStreams();
      const exit2 = await runCli(
        ['ingest', '--import', archivePath, '--vault', vaultRoot],
        streams2,
      );
      expect(exit2).toBe(0);
      expect(streams2.stdout.text()).toContain('imported=0');
      expect(streams2.stdout.text()).toContain('skipped=1');
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('engagement backfill-aggregates dry-runs then applies idempotently', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'engagement-backfill-'));
    try {
      // Seed the log with two edge-origin interval events for one visit
      // and one for a visit that already has a real aggregate (must be
      // excluded). Import them via the same edge lane the extension uses.
      const { createEventLog } = await import('./sync/eventLog.js');
      const { loadOrCreateReplica } = await import('./sync/replicaId.js');
      const replica = await loadOrCreateReplica(vaultRoot);
      const log = createEventLog(vaultRoot, replica);
      const dims = (focusedWindowMs: number) => ({
        activeMs: focusedWindowMs,
        visibleMs: focusedWindowMs,
        focusedWindowMs,
        idleMs: 0,
        foregroundBursts: 1,
        returnCount: 0,
        scrollEvents: 0,
        maxScrollRatio: 0,
        copyCount: 0,
        pasteCount: 0,
      });
      const seed = [
        {
          clientEventId: 'iv-1',
          dot: { replicaId: 'edge_seed', seq: 1 },
          deps: {},
          aggregateId: 'engagement.interval.observed:visit:gap',
          type: 'engagement.interval.observed',
          payload: {
            payloadVersion: 1,
            visitId: 'visit:gap',
            intervalStart: 1000,
            intervalEnd: 2000,
            dimensions: { engagement: dims(4000) },
          },
          acceptedAtMs: 5_000,
        },
        {
          clientEventId: 'iv-2',
          dot: { replicaId: 'edge_seed', seq: 2 },
          deps: {},
          aggregateId: 'engagement.interval.observed:visit:gap',
          type: 'engagement.interval.observed',
          payload: {
            payloadVersion: 1,
            visitId: 'visit:gap',
            intervalStart: 2000,
            intervalEnd: 3000,
            dimensions: { engagement: dims(3000) },
          },
          acceptedAtMs: 6_000,
        },
        {
          clientEventId: 'iv-3',
          dot: { replicaId: 'edge_seed', seq: 3 },
          deps: {},
          aggregateId: 'engagement.interval.observed:visit:has-agg',
          type: 'engagement.interval.observed',
          payload: {
            payloadVersion: 1,
            visitId: 'visit:has-agg',
            intervalStart: 1000,
            intervalEnd: 2000,
            dimensions: { engagement: dims(9000) },
          },
          acceptedAtMs: 5_000,
        },
        {
          clientEventId: 'ag-1',
          dot: { replicaId: 'edge_seed', seq: 4 },
          deps: {},
          aggregateId: 'engagement.session.aggregated:visit:has-agg',
          type: 'engagement.session.aggregated',
          payload: {
            payloadVersion: 1,
            visitId: 'visit:has-agg',
            sessionId: 'session:real',
            dimensions: { engagement: dims(9000) },
          },
          acceptedAtMs: 6_000,
        },
      ];
      for (const event of seed) await log.importPeerEvent(event as never);

      // Dry-run: reports the plan, writes nothing.
      const dry = createStreams();
      const dryExit = await runCli(
        ['engagement', 'backfill-aggregates', '--vault', vaultRoot],
        dry,
      );
      expect(dryExit).toBe(0);
      expect(dry.stdout.text()).toContain('toSynthesize=1');
      expect(dry.stdout.text()).toContain('alreadyAggregated=1');
      expect(dry.stdout.text()).toContain('dry-run: no events written');

      // Apply: appends exactly the one missing aggregate (visit:gap).
      const apply1 = createStreams();
      const applyExit = await runCli(
        ['engagement', 'backfill-aggregates', '--vault', vaultRoot, '--apply'],
        apply1,
      );
      expect(applyExit).toBe(0);
      expect(apply1.stdout.text()).toContain('imported=1');

      // The synthetic aggregate is in the log for visit:gap with the
      // summed focusedWindowMs (4000 + 3000).
      const merged = await log.readMerged();
      const synthetic = merged.find(
        (e) =>
          e.type === 'engagement.session.aggregated' &&
          (e.payload as { visitId?: string }).visitId === 'visit:gap',
      );
      expect(synthetic).toBeDefined();
      expect(synthetic?.dot.replicaId).toBe('edge_backfill');
      expect(
        (synthetic?.payload as { dimensions: { engagement: { focusedWindowMs: number } } }).dimensions
          .engagement.focusedWindowMs,
      ).toBe(7000);

      // Re-apply: visit:gap now HAS an aggregate (the one we just wrote),
      // so it's excluded → nothing to synthesize. Idempotent by
      // construction: a second pass can never double-write.
      const apply2 = createStreams();
      const reapplyExit = await runCli(
        ['engagement', 'backfill-aggregates', '--vault', vaultRoot, '--apply'],
        apply2,
      );
      expect(reapplyExit).toBe(0);
      expect(apply2.stdout.text()).toContain('toSynthesize=0');
      expect(apply2.stdout.text()).toContain('imported=0');
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it('recall reingest refuses when the recall process-lock is held by a live foreign PID', async () => {
    // A running companion holds `_BAC/recall/.lock` for the same
    // single-writer reason that `recall reingest` does — letting them
    // race the index file would tear the binary. Same trick as the
    // recovery unit test: write the parent shell's PID into the lock
    // (it's alive and isn't us) and check the CLI refuses.
    const parentPid = process.ppid;
    if (!Number.isFinite(parentPid) || parentPid <= 0) return;
    const vaultRoot = await mkdtemp(join(tmpdir(), 'recall-reingest-locked-'));
    try {
      await mkdir(join(vaultRoot, '_BAC', 'recall'), { recursive: true });
      await writeFile(join(vaultRoot, '_BAC', 'recall', '.lock'), `${String(parentPid)}\n`, 'utf8');
      const streams = createStreams();
      const exitCode = await runCli(['recall', 'reingest', '--vault', vaultRoot], streams);
      expect(exitCode).toBe(1);
      expect(streams.stderr.text()).toContain('refusing');
      expect(streams.stderr.text()).toContain(String(parentPid));
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});

describe('renderServiceNextSteps', () => {
  it('names the platform manager and the auto-respawn behaviour (darwin)', () => {
    const text = renderServiceNextSteps({
      platform: 'darwin',
      path: '/home/test/Library/LaunchAgents/com.sidetrack.companion.plist',
      vaultPath: '/home/test/sidetrack-vault',
      port: 17373,
    });
    expect(text).toContain('service installed (darwin)');
    expect(text).toContain('launchd');
    expect(text).toContain('restarts automatically');
    expect(text).toContain(
      'service file : /home/test/Library/LaunchAgents/com.sidetrack.companion.plist',
    );
  });

  it('surfaces the vault, API URL, bridge key, pairing token, and management commands', () => {
    const text = renderServiceNextSteps({
      platform: 'linux',
      path: '/home/test/.config/systemd/user/sidetrack-companion.service',
      vaultPath: '/home/test/vault',
      port: 17380,
    });
    expect(text).toContain('systemd (user)');
    expect(text).toContain('vault        : /home/test/vault');
    expect(text).toContain('API          : http://127.0.0.1:17380');
    expect(text).toContain('bridge key   : /home/test/vault/_BAC/.config/bridge.key');
    expect(text).toContain('/home/test/vault/_BAC/.config/pair.txt');
    expect(text).toContain('--service-status');
    expect(text).toContain('--uninstall-service');
  });
});
