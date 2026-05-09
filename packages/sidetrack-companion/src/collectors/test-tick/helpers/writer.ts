// Stage 4 — synthetic test-tick collector fixture writer.
//
// Drives compass §2.G structural tests #2 / #3 / #4 / #6. Emits
// JSONL lines shaped as the collector framework's wire contract
// (CollectorEvent) into _BAC/inbox/sidetrack.test-tick/<date>.jsonl
// using temp-then-rename atomic writes (mirrors the textfile-
// collector idiom).
//
// This is a TEST FIXTURE, not a real collector. The corresponding
// materializer lives at src/collectors/test-tick/materializers.ts
// (S16 implementation). Together they let the spine.e2e.ts harness
// drive arbitrary line counts through the promotion choke point
// without depending on Codex CLI / Claude Code being installed.

import { mkdir, rename, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TEST_TICK_COLLECTOR_ID = 'sidetrack.test-tick' as const;
const TEST_TICK_COLLECTOR_VERSION = '0.1.0' as const;

// Same shape as the default test-tick lines but parameterized by
// collector_id so spine.e2e.ts test #6 can drive two collectors
// emitting the same event_type ("tick") with distinct ruleIds.

export interface TestTickWriteOpts {
  readonly vaultRoot: string;
  readonly collectorRunId?: string; // ULID-ish; auto-generated if omitted
  readonly payloadVersion?: number; // defaults to 1
  readonly emittedAtBase?: Date; // tick i emitted at base + i ms
  readonly dateStamp?: string; // YYYY-MM-DD; defaults to today UTC
}

export interface TestTickLine {
  readonly collector_id: typeof TEST_TICK_COLLECTOR_ID;
  readonly event_type: 'tick';
  readonly payload_version: number;
  readonly emitted_at: string;
  readonly collector_version: string;
  readonly collector_run_id: string;
  readonly source_record_id: string;
  readonly payload: { readonly tick_index: number; readonly message?: string };
  readonly dimensions?: Record<string, unknown>;
}

const generateRunId = (): string =>
  // Cheap ULID surrogate — 26 alphanumerics is enough for test fixtures.
  randomBytes(13).toString('base64url').slice(0, 26);

const dateStampUtc = (d: Date): string => d.toISOString().slice(0, 10);

const inboxFilePath = (vaultRoot: string, dateStamp: string): string =>
  join(vaultRoot, '_BAC', 'inbox', TEST_TICK_COLLECTOR_ID, `${dateStamp}.jsonl`);

const tempPathFor = (finalPath: string): string =>
  join(
    dirname(finalPath),
    `.${finalPath.split('/').pop()}.${randomBytes(4).toString('hex')}.tmp`,
  );

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const buildLine = (
  tickIndex: number,
  base: Date,
  runId: string,
  payloadVersion: number,
  message?: string,
): TestTickLine => {
  const emittedAt = new Date(base.getTime() + tickIndex).toISOString();
  return {
    collector_id: TEST_TICK_COLLECTOR_ID,
    event_type: 'tick',
    payload_version: payloadVersion,
    emitted_at: emittedAt,
    collector_version: TEST_TICK_COLLECTOR_VERSION,
    collector_run_id: runId,
    source_record_id: `${runId}:${String(tickIndex).padStart(8, '0')}`,
    payload: message === undefined ? { tick_index: tickIndex } : { tick_index: tickIndex, message },
  };
};

// Append `count` ticks atomically. Each tick becomes one JSONL line.
// Because the textfile-collector pattern is "write-then-rename whole
// file," we read any existing content first, build the merged body,
// and rename a fresh temp file into place. This keeps the inbox file
// in a consistent state from the companion tail's perspective.
//
// (A real collector would append-and-fsync line-by-line; the test
// fixture takes the simpler atomic-rename approach because it writes
// in one shot.)
export const writeTickBatch = async (
  count: number,
  opts: TestTickWriteOpts & { readonly collectorId?: string },
): Promise<{ readonly runId: string; readonly path: string; readonly lines: number }> => {
  const collectorId = opts.collectorId ?? TEST_TICK_COLLECTOR_ID;
  const runId = opts.collectorRunId ?? generateRunId();
  const base = opts.emittedAtBase ?? new Date();
  const payloadVersion = opts.payloadVersion ?? 1;
  const dateStamp = opts.dateStamp ?? dateStampUtc(base);
  const finalPath = join(
    opts.vaultRoot,
    '_BAC',
    'inbox',
    collectorId,
    `${dateStamp}.jsonl`,
  );

  await mkdir(dirname(finalPath), { recursive: true });

  const existing = (await fileExists(finalPath)) ? await readFile(finalPath, 'utf8') : '';

  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const line = buildLine(i, base, runId, payloadVersion);
    // Override collector_id at the line level when the param is set.
    lines.push(JSON.stringify({ ...line, collector_id: collectorId }));
  }
  const merged = existing + lines.join('\n') + (lines.length > 0 ? '\n' : '');

  const temp = tempPathFor(finalPath);
  await writeFile(temp, merged, 'utf8');
  await rename(temp, finalPath);

  return { runId, path: finalPath, lines: lines.length };
};

// Append a single deliberately-malformed line (test #2's negative
// branch and the line-malformed audit subtype).
export const writeMalformedLine = async (
  raw: string,
  opts: { readonly vaultRoot: string; readonly dateStamp?: string },
): Promise<{ readonly path: string }> => {
  const dateStamp = opts.dateStamp ?? dateStampUtc(new Date());
  const finalPath = inboxFilePath(opts.vaultRoot, dateStamp);
  await mkdir(dirname(finalPath), { recursive: true });
  const existing = (await fileExists(finalPath)) ? await readFile(finalPath, 'utf8') : '';
  const merged = `${existing}${raw}\n`;
  const temp = tempPathFor(finalPath);
  await writeFile(temp, merged, 'utf8');
  await rename(temp, finalPath);
  return { path: finalPath };
};

// Append one tick at a future payload_version (drives test #3 —
// quarantine then replay-on-upgrade).
export const writeFutureVersionTick = async (
  futureVersion: number,
  opts: TestTickWriteOpts,
): Promise<{ readonly runId: string; readonly path: string }> => {
  const result = await writeTickBatch(1, { ...opts, payloadVersion: futureVersion });
  return { runId: result.runId, path: result.path };
};

export {
  TEST_TICK_COLLECTOR_ID,
  TEST_TICK_COLLECTOR_VERSION,
  inboxFilePath as testTickInboxFilePath,
};
