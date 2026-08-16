import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkPhaseBudgetExceeded, phaseBudgetMs } from './phaseBudget.js';

const ENV_KEY = 'SIDETRACK_PHASE_BUDGET_MS';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('phaseBudgetMs', () => {
  it('defaults to 120000ms', () => {
    delete process.env[ENV_KEY];
    expect(phaseBudgetMs()).toBe(120_000);
  });

  it('reads SIDETRACK_PHASE_BUDGET_MS when set to a valid positive integer', () => {
    process.env[ENV_KEY] = '5000';
    expect(phaseBudgetMs()).toBe(5000);
  });

  it('falls back to the default on an invalid value', () => {
    process.env[ENV_KEY] = 'not-a-number';
    expect(phaseBudgetMs()).toBe(120_000);
    process.env[ENV_KEY] = '-5';
    expect(phaseBudgetMs()).toBe(120_000);
    process.env[ENV_KEY] = '0';
    expect(phaseBudgetMs()).toBe(120_000);
  });
});

describe('checkPhaseBudgetExceeded', () => {
  it('logs [phase.budget-exceeded] for a phase over budget and returns its label', () => {
    process.env[ENV_KEY] = '1000';
    const lines: string[] = [];
    const flagged = checkPhaseBudgetExceeded(
      [
        { label: 'w6 keys=3', durationMs: 12 },
        { label: 'readMerged', durationMs: 1800300 }, // the incident's own shape
      ],
      (line) => lines.push(line),
    );
    expect(flagged).toEqual(['readMerged']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[phase.budget-exceeded] phase=readMerged dt=1800300ms budgetMs=1000');
  });

  it('logs nothing when every phase is within budget', () => {
    process.env[ENV_KEY] = '1000';
    const lines: string[] = [];
    const flagged = checkPhaseBudgetExceeded(
      [
        { label: 'w6 keys=3', durationMs: 12 },
        { label: 'readMerged', durationMs: 900 },
      ],
      (line) => lines.push(line),
    );
    expect(flagged).toEqual([]);
    expect(lines).toHaveLength(0);
  });

  it('flags every phase over budget, not just the first', () => {
    process.env[ENV_KEY] = '100';
    const lines: string[] = [];
    const flagged = checkPhaseBudgetExceeded(
      [
        { label: 'a', durationMs: 200 },
        { label: 'b', durationMs: 50 },
        { label: 'c', durationMs: 300 },
      ],
      (line) => lines.push(line),
    );
    expect(flagged).toEqual(['a', 'c']);
    expect(lines).toHaveLength(2);
  });

  it('handles undefined/empty input without throwing', () => {
    expect(checkPhaseBudgetExceeded(undefined)).toEqual([]);
    expect(checkPhaseBudgetExceeded([])).toEqual([]);
  });

  it('never throws even if the logger throws', () => {
    process.env[ENV_KEY] = '10';
    expect(() =>
      checkPhaseBudgetExceeded([{ label: 'a', durationMs: 999 }], () => {
        throw new Error('logger exploded');
      }),
    ).not.toThrow();
  });

  it('defaults to console.warn when no logger is passed', () => {
    process.env[ENV_KEY] = '10';
    const flagged = checkPhaseBudgetExceeded([{ label: 'default-logger', durationMs: 999 }]);
    expect(flagged).toEqual(['default-logger']);
  });
});
