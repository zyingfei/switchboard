import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginBudgetGuard } from '../../../src/sync/pluginMaterializer';
import { DEFAULT_PLUGIN_BUDGETS } from '../../../src/sync/budgetConfig';
import { runExtendedQuery } from '../../../src/sync/extendedQuery';
import { drainSpoolToCompanion } from '../../../src/sync/spoolDrainer';
import { spoolAppend, type SpoolEntry } from '../../../src/sync/spool';
import { captureQueueHealth } from '../../../src/sync/captureQueueClassF';

// Lane 3 / L3-G1 — Mode P functional under storage pressure.
//
// "Mode P" = plugin alone, companion unreachable. The contract:
//   - Explicit user actions: accepted if active/spool/export
//     capacity exists; otherwise visibly rejected. Never silently
//     dropped.
//   - Passive captures: may be sampled / dropped / summarized by
//     policy. Degradation is health-visible.
//   - Side panel renders Class F active windows (always responsive,
//     bounded).
//   - Recall queries fall back to active-window scope.
//   - Mode-down is observable.
//
// This test asserts each clause without spinning up a real
// companion — we just check the plugin-tier modules behave
// correctly when the companion port reports unreachable.

const stubChromeStorage = (initial: Record<string, unknown> = {}): void => {
  const store: Record<string, unknown> = { ...initial };
  const get = (req: unknown): Promise<Record<string, unknown>> => {
    if (typeof req === 'string') return Promise.resolve({ [req]: store[req] });
    if (Array.isArray(req)) {
      const out: Record<string, unknown> = {};
      for (const k of req) out[k] = store[k];
      return Promise.resolve(out);
    }
    if (typeof req === 'object' && req !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, fb] of Object.entries(req)) out[k] = k in store ? store[k] : fb;
      return Promise.resolve(out);
    }
    return Promise.resolve({});
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(get),
        set: vi.fn((entries: Record<string, unknown>) => {
          Object.assign(store, entries);
          return Promise.resolve();
        }),
      },
    },
  };
};

describe('Lane 3 / L3-G1 — Mode P functional', () => {
  beforeEach(() => {
    stubChromeStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('explicit user action accepted while spool capacity exists (no silent drop)', () => {
    const guard = new PluginBudgetGuard(DEFAULT_PLUGIN_BUDGETS);
    const result = guard.decideAdmit({
      intent: 'explicit',
      activeSetCount: 200,
      spoolCount: 5,
      activeSetBudget: 200,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tier).toBe('spool');
  });

  it('explicit user action visibly rejected when both active AND explicit spool full', () => {
    const guard = new PluginBudgetGuard({
      ...DEFAULT_PLUGIN_BUDGETS,
      maxExplicitPending: 5,
    });
    const result = guard.decideAdmit({
      intent: 'explicit',
      activeSetCount: 200,
      spoolCount: 5,
      activeSetBudget: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('spool-full-explicit');
    }
    // The metric is non-zero — degradation is observable.
    expect(guard.metrics().failedExplicit).toBe(1);
  });

  it('passive overflow degrades by policy (drop-passive); count is health-visible', () => {
    const guard = new PluginBudgetGuard({
      ...DEFAULT_PLUGIN_BUDGETS,
      maxPassivePending: 3,
    });
    for (let i = 0; i < 5; i += 1) {
      guard.decideAdmit({
        intent: 'passive',
        activeSetCount: 200,
        spoolCount: 3,
        activeSetBudget: 200,
      });
    }
    expect(guard.metrics().droppedPassive).toBe(5);
  });

  it('recall query in Mode P falls back to plugin-active-only scope with documented note', async () => {
    const result = await runExtendedQuery<{ id: string }>({
      companionReachable: async () => false,
      fetchFromCompanion: async () => null,
      readActive: async () => [{ id: 'a' }, { id: 'b' }],
    });
    expect(result.scope).toBe('plugin-active-only-companion-unreachable');
    expect(result.note).toContain('companion unavailable');
    expect(result.items).toHaveLength(2);
  });

  it('captureQueueHealth surfaces failed-explicit count when queue overflowed without companion', async () => {
    stubChromeStorage({
      'sidetrack.captureQueue': [],
      'sidetrack.captureQueue.droppedCount': 12,
      'sidetrack.captureQueue.failed': [
        {
          id: 'cap-1',
          queuedAt: '2026-05-07T00:00:00.000Z',
          failedAt: '2026-05-07T00:01:00.000Z',
          event: {
            provider: 'chatgpt',
            threadUrl: 'https://x',
            capturedAt: '2026-05-07T00:00:00.000Z',
            turns: [],
          },
        },
      ],
    });
    const health = await captureQueueHealth();
    expect(health.status).toBe('failed');
    expect(health.failedExplicitCount).toBe(1);
    expect(health.droppedPassiveCount).toBe(12);
    expect(health.lastError).toContain('explicit captures rejected');
  });

  it('spool persists during offline and drainer is a no-op without companion', async () => {
    const entry: SpoolEntry = {
      edgeDot: { replicaId: 'edge_modeP', seq: 1 },
      clientEventId: 'evt-1',
      surface: 'threads',
      payload: {},
      state: 'spooled',
      createdAt: '2026-05-07T00:00:00.000Z',
      lastTransitionAt: '2026-05-07T00:00:00.000Z',
    };
    await spoolAppend('threads', entry);
    // Companion-unreachable port: every importEvent throws.
    const result = await drainSpoolToCompanion('threads', {
      importEvent: async () => {
        throw new Error('companion-unreachable');
      },
    });
    expect(result.uploaded).toBe(0);
    expect(result.remaining).toBe(1);
    // Entry is still in spool, ready to retry on reconnect.
  });
});
