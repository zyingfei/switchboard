import { afterEach, describe, expect, it } from 'vitest';

import { startEventLoopMonitor } from './eventLoopMonitor.js';
import { __resetInflightRegistry, completeInflight, registerInflight } from './inflightRegistry.js';

afterEach(() => {
  __resetInflightRegistry();
});

/**
 * Collect the monitor's log lines for `waitMs`, then stop it.
 *
 * `warnThresholdMs: 0` makes every sampling tick emit a stall line, so the
 * FORMAT is testable without having to actually pin the event loop for a
 * quarter of a second inside a unit test. The tick interval is
 * `max(resolutionMs * 5, 100)`, so ~250ms of waiting yields at least two ticks.
 */
const collectLines = async (waitMs = 260): Promise<readonly string[]> => {
  const lines: string[] = [];
  const monitor = startEventLoopMonitor({
    resolutionMs: 20,
    warnThresholdMs: 0,
    logger: (line) => {
      lines.push(line);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  monitor.stop();
  return lines;
};

const stallLines = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => line.startsWith('[api.stall]'));

describe('[api.stall] self-attribution', () => {
  it('names the in-flight routes that were running when the stall was noticed', async () => {
    // The case this exists for: a multi-second route still running while the
    // watchdog fires. Before this field the line said only how long the loop
    // was blocked, and every investigation began by guessing the endpoint.
    const id = registerInflight('POST:/v1/visits/batch-resolve');
    const lines = await collectLines();
    completeInflight(id);
    const stalls = stallLines(lines);
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls[0]).toContain('inflight=POST:/v1/visits/batch-resolve:');
    // Still the same one-line key=value shape: the new field sits before the
    // trailing prose `note=`, and does not disturb the existing fields.
    expect(stalls[0]).toMatch(
      /^\[api\.stall\] eventLoopBlockedMs=\d+ thresholdMs=\d+ resolutionMs=\d+ inflight=\S+ note=/u,
    );
  });

  it('says `none` rather than inventing a culprit when nothing is in flight', async () => {
    const stalls = stallLines(await collectLines());
    expect(stalls.length).toBeGreaterThan(0);
    expect(stalls[0]).toContain('inflight=none');
  });

  it('lists at most three routes, longest-running first', async () => {
    const first = registerInflight('POST:/v1/visits/batch-resolve');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rest = [
      registerInflight('GET:/v1/status'),
      registerInflight('GET:/v1/page-content'),
      registerInflight('GET:/v1/connections'),
      registerInflight('GET:/v1/health'),
    ];
    const lines = await collectLines();
    completeInflight(first);
    for (const id of rest) completeInflight(id);
    const field = /inflight=(\S+) note=/u.exec(stallLines(lines)[0] ?? '')?.[1] ?? '';
    const entries = field.split('|');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain('POST:/v1/visits/batch-resolve:');
  });

  it('drops the attribution once the request completes (no stale culprit)', async () => {
    const id = registerInflight('POST:/v1/visits/batch-resolve');
    completeInflight(id);
    const stalls = stallLines(await collectLines());
    expect(stalls[0]).toContain('inflight=none');
  });
});

describe('[api.busy] self-attribution', () => {
  it('carries the same field when it fires', async () => {
    // The busy line only fires when utilization crosses the threshold, which a
    // quiet test process may not do — assert the shape only when it appears.
    const id = registerInflight('POST:/v1/visits/batch-resolve');
    const busy = (await collectLines()).filter((line) => line.startsWith('[api.busy]'));
    completeInflight(id);
    for (const line of busy) {
      expect(line).toMatch(/ inflight=\S+ note=/u);
    }
  });
});
