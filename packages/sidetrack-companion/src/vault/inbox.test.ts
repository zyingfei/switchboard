import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bookmarkPathFor,
  inboxArchiveDirFor,
  inboxDirFor,
  inboxFileFor,
  inboxRootFor,
  manifestDirFor,
  manifestPathFor,
  manifestRootFor,
  parseDateStamp,
  quarantineDirFor,
  quarantineFileFor,
  quarantineRootFor,
  validCollectorId,
} from './inbox.js';

describe('inbox path helpers', () => {
  const vaultRoot = '/vault';
  const collectorId = 'sidetrack.codex-cli';
  const iso = '2026-05-08T16:45:00.000Z';
  const date = new Date(iso);

  it('builds the collector inbox root path', () => {
    expect(inboxRootFor(vaultRoot)).toBe('/vault/_BAC/inbox');
  });

  it('builds a collector inbox directory path', () => {
    expect(inboxDirFor(vaultRoot, collectorId)).toBe('/vault/_BAC/inbox/sidetrack.codex-cli');
  });

  it('builds daily collector inbox file paths from ISO strings and Dates', () => {
    expect(inboxFileFor(vaultRoot, collectorId, iso)).toBe(
      '/vault/_BAC/inbox/sidetrack.codex-cli/2026-05-08.jsonl',
    );
    expect(inboxFileFor(vaultRoot, collectorId, date)).toBe(
      '/vault/_BAC/inbox/sidetrack.codex-cli/2026-05-08.jsonl',
    );
  });

  it('builds a collector inbox archive directory path', () => {
    expect(inboxArchiveDirFor(vaultRoot, collectorId)).toBe(
      '/vault/_BAC/inbox/sidetrack.codex-cli/archive',
    );
  });

  it('builds a collector bookmark path', () => {
    expect(bookmarkPathFor(vaultRoot, collectorId)).toBe(
      '/vault/_BAC/inbox/sidetrack.codex-cli/.bookmark.json',
    );
  });

  it('builds collector manifest paths', () => {
    expect(manifestRootFor(vaultRoot)).toBe('/vault/_BAC/collectors');
    expect(manifestDirFor(vaultRoot, collectorId)).toBe(
      '/vault/_BAC/collectors/sidetrack.codex-cli',
    );
    expect(manifestPathFor(vaultRoot, collectorId)).toBe(
      '/vault/_BAC/collectors/sidetrack.codex-cli/collector.toml',
    );
  });

  it('builds quarantine paths from ISO strings and Dates', () => {
    expect(quarantineRootFor(vaultRoot)).toBe('/vault/_BAC/audit/quarantine');
    expect(quarantineDirFor(vaultRoot, iso)).toBe('/vault/_BAC/audit/quarantine/2026-05-08');
    expect(quarantineDirFor(vaultRoot, date)).toBe('/vault/_BAC/audit/quarantine/2026-05-08');
    expect(quarantineFileFor(vaultRoot, collectorId, iso)).toBe(
      '/vault/_BAC/audit/quarantine/2026-05-08/sidetrack.codex-cli.jsonl',
    );
    expect(quarantineFileFor(vaultRoot, collectorId, date)).toBe(
      '/vault/_BAC/audit/quarantine/2026-05-08/sidetrack.codex-cli.jsonl',
    );
  });

  it('parses YYYY-MM-DD date stamps from ISO strings and Dates', () => {
    expect(parseDateStamp(iso)).toBe('2026-05-08');
    expect(parseDateStamp(date)).toBe('2026-05-08');
  });
});

describe('validCollectorId', () => {
  it.each([
    ['sidetrack.codex-cli', true],
    ['a.b.c', true],
    ['', false],
    ['A', false],
    ['.bad', false],
    ['bad.', false],
    ['-bad', false],
    ['bad-', false],
    ['BAD', false],
    ['has space', false],
    ['a', false],
  ] as const)('returns %s for %s', (collectorId, expected) => {
    expect(validCollectorId(collectorId)).toBe(expected);
  });
});

describe('vault directory shape guard', () => {
  let vaultRoot: string | undefined;

  afterEach(() => {
    if (vaultRoot !== undefined) {
      rmSync(vaultRoot, { recursive: true, force: true });
      vaultRoot = undefined;
    }
  });

  it('contains only documented _BAC directories through depth 2', () => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'sidetrack-inbox-shape-'));
    const bacRoot = join(vaultRoot, '_BAC');
    const documented = new Set([
      'events',
      'threads',
      'workstreams',
      'dispatches',
      'coding',
      'recall',
      'timeline',
      '.config',
      'audit',
      'inbox',
      'collectors',
      'audit/quarantine',
    ]);

    for (const directory of documented) {
      mkdirSync(join(bacRoot, directory), { recursive: true });
    }

    const discovered: string[] = [];
    for (const entry of readdirSync(bacRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      discovered.push(entry.name);
      const childRoot = join(bacRoot, entry.name);
      for (const child of readdirSync(childRoot, { withFileTypes: true })) {
        if (child.isDirectory()) {
          discovered.push(join(entry.name, child.name));
        }
      }
    }

    expect(discovered.sort()).toEqual(Array.from(documented).sort());
    expect(discovered.every((directory) => documented.has(directory))).toBe(true);
  });
});
