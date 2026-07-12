import { describe, expect, it } from 'vitest';

import { withBunSmolCommand } from './bunMemory.js';

describe('Bun memory launch helpers', () => {
  it('inserts --smol after a direct Bun executable', () => {
    expect(withBunSmolCommand(['/usr/local/bin/bun', 'dist/cli.js'])).toEqual([
      '/usr/local/bin/bun',
      '--smol',
      'dist/cli.js',
    ]);
  });

  it('inserts --smol after an npx Bun package token', () => {
    expect(withBunSmolCommand(['npx', '--yes', 'bun@1.3.14', 'dist/cli.js'])).toEqual([
      'npx',
      '--yes',
      'bun@1.3.14',
      '--smol',
      'dist/cli.js',
    ]);
  });

  it('does not rewrite non-Bun commands or duplicate --smol', () => {
    expect(withBunSmolCommand(['sidetrack-companion', '--vault', '/vault'])).toEqual([
      'sidetrack-companion',
      '--vault',
      '/vault',
    ]);
    expect(withBunSmolCommand(['bun', '--smol', 'dist/cli.js'])).toEqual([
      'bun',
      '--smol',
      'dist/cli.js',
    ]);
  });
});
