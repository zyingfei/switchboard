import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_BUDGETS } from '../../../src/sync/budgetConfig';
import { PluginBudgetGuard } from '../../../src/sync/pluginMaterializer';
import { buildScopedResult, noteForScope } from '../../../src/sync/resultScope';

// Lane 3 / L3.S2 + L3.S5 — bounded budgets + scope-marked results.
//
// Asserts:
//   L3-G2: active overflow → spool admission with explicit
//          intent succeeds while explicit spool capacity remains.
//   L3-G8: spool overflow with explicit intent → visible
//          rejection (failed-explicit). Passive overflow →
//          policy drop (drop-passive).
//   L3-G9: ScopedResult carries a `note` for non-trivial scopes
//          so the side panel can render the boundary honestly.

describe('PluginBudgetGuard', () => {
  it('admits to active when active is below budget', () => {
    const guard = new PluginBudgetGuard(DEFAULT_PLUGIN_BUDGETS);
    const result = guard.decideAdmit({
      intent: 'explicit',
      activeSetCount: 100,
      spoolCount: 0,
      activeSetBudget: 200,
    });
    expect(result).toEqual({ ok: true, tier: 'active' });
  });

  it('overflows to spool when active is full and explicit pending capacity remains', () => {
    const guard = new PluginBudgetGuard(DEFAULT_PLUGIN_BUDGETS);
    const result = guard.decideAdmit({
      intent: 'explicit',
      activeSetCount: 200,
      spoolCount: 50,
      activeSetBudget: 200,
    });
    expect(result).toEqual({ ok: true, tier: 'spool' });
  });

  it('rejects explicit when both active AND explicit spool are full', () => {
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
    expect(result).toEqual({ ok: false, reason: 'spool-full-explicit' });
    expect(guard.metrics().failedExplicit).toBe(1);
  });

  it('drops passive (policy) when both active AND passive spool are full', () => {
    const guard = new PluginBudgetGuard({
      ...DEFAULT_PLUGIN_BUDGETS,
      maxPassivePending: 5,
    });
    const result = guard.decideAdmit({
      intent: 'passive',
      activeSetCount: 200,
      spoolCount: 5,
      activeSetBudget: 200,
    });
    expect(result).toEqual({ ok: false, reason: 'spool-full-passive-policy-drop' });
    expect(guard.metrics().droppedPassive).toBe(1);
  });
});

describe('ResultScope', () => {
  it('plugin-active-only-companion-unreachable carries the documented note', () => {
    const result = buildScopedResult('plugin-active-only-companion-unreachable', []);
    expect(result.note).toBe('Showing recent local history only — companion unavailable.');
  });

  it('archive-exported-not-imported carries the import-recovery note', () => {
    const result = buildScopedResult('archive-exported-not-imported', []);
    expect(result.note).toContain('exported archive packs');
  });

  it('plugin-active scope has no note (fast path; nothing to explain)', () => {
    expect(noteForScope('plugin-active')).toBeUndefined();
  });
});
