import { describe, expect, it } from 'vitest';

import { companionStatusLabel, initialWorkboardSections } from '../../src/workboard';

describe('workboard scaffold', () => {
  it('defines the six M1 workboard sections in display order', () => {
    expect(initialWorkboardSections.map((section) => section.id)).toEqual([
      'current-tab',
      'active-work',
      'queued',
      'inbound',
      'needs-organize',
      'recent-search',
    ]);
  });

  it('maps companion status to side-panel copy', () => {
    expect(companionStatusLabel('connected')).toBe('vault: synced');
    expect(companionStatusLabel('disconnected')).toBe('vault: disconnected');
    expect(companionStatusLabel('vault-error')).toBe('vault: unreachable');
    expect(companionStatusLabel('local-only')).toBe('local-only');
  });
});
