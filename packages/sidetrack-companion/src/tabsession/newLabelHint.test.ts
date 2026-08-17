import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createKeywordIndexStore } from '../search-index/keywordIndexStore.js';
import {
  NEW_LABEL_HINT_ENV,
  NEW_LABEL_HINT_MIN_KEYWORDS,
  computeNewLabelHint,
  newLabelHintEnabled,
  newLabelHintForPage,
  resetNewLabelHintHandlesForTest,
} from './newLabelHint.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

describe('computeNewLabelHint — pure', () => {
  it('returns null for undefined (never keyword-indexed)', () => {
    expect(computeNewLabelHint(undefined)).toBeNull();
  });

  it('returns null below NEW_LABEL_HINT_MIN_KEYWORDS', () => {
    expect(NEW_LABEL_HINT_MIN_KEYWORDS).toBe(2);
    expect(computeNewLabelHint([])).toBeNull();
    expect(computeNewLabelHint(['solo'])).toBeNull();
  });

  it('returns a hint at/above the floor, carrying every keyword', () => {
    const hint = computeNewLabelHint(['rust', 'ownership']);
    expect(hint).toEqual({ name: 'rust ownership', keywords: ['rust', 'ownership'] });
  });

  it('names from the top 3 keywords, keeping the full list', () => {
    const hint = computeNewLabelHint(['rust', 'ownership', 'borrowing', 'lifetimes', 'traits']);
    expect(hint?.name).toBe('rust ownership borrowing');
    expect(hint?.keywords).toEqual(['rust', 'ownership', 'borrowing', 'lifetimes', 'traits']);
  });
});

describe('newLabelHintEnabled — env flag', () => {
  const prev = process.env[NEW_LABEL_HINT_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[NEW_LABEL_HINT_ENV];
    else process.env[NEW_LABEL_HINT_ENV] = prev;
  });

  it('defaults to enabled when unset', () => {
    delete process.env[NEW_LABEL_HINT_ENV];
    expect(newLabelHintEnabled()).toBe(true);
  });

  it('is disabled by "0" or "false"', () => {
    process.env[NEW_LABEL_HINT_ENV] = '0';
    expect(newLabelHintEnabled()).toBe(false);
    process.env[NEW_LABEL_HINT_ENV] = 'false';
    expect(newLabelHintEnabled()).toBe(false);
  });
});

describe('newLabelHintForPage — per-vault store lookup', () => {
  let vaultRoot: string;
  const prevFlag = process.env[NEW_LABEL_HINT_ENV];

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'new-label-hint-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    resetNewLabelHintHandlesForTest();
  });

  afterEach(async () => {
    resetNewLabelHintHandlesForTest();
    if (prevFlag === undefined) delete process.env[NEW_LABEL_HINT_ENV];
    else process.env[NEW_LABEL_HINT_ENV] = prevFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  sqliteIt('returns the hint for a page with >=2 indexed keywords', async () => {
    const index = await createKeywordIndexStore(vaultRoot);
    try {
      index.upsertPageKeywords(
        'url:https://a.example/rust',
        ['rust', 'ownership', 'systems'],
        'deterministic',
        100,
      );
    } finally {
      index.close();
    }
    const hint = await newLabelHintForPage(vaultRoot, 'https://a.example/rust');
    expect(hint).toEqual({
      name: 'rust ownership systems',
      keywords: ['rust', 'ownership', 'systems'],
    });
  });

  sqliteIt('returns null for a page never keyword-indexed', async () => {
    const hint = await newLabelHintForPage(vaultRoot, 'https://never-indexed.example/');
    expect(hint).toBeNull();
  });

  sqliteIt('returns null for a page indexed with fewer than 2 keywords', async () => {
    const index = await createKeywordIndexStore(vaultRoot);
    try {
      index.upsertPageKeywords('url:https://a.example/solo', ['solo'], 'deterministic', 100);
    } finally {
      index.close();
    }
    const hint = await newLabelHintForPage(vaultRoot, 'https://a.example/solo');
    expect(hint).toBeNull();
  });

  sqliteIt('returns null when the flag is off — no store handle opened at all', async () => {
    const index = await createKeywordIndexStore(vaultRoot);
    try {
      index.upsertPageKeywords(
        'url:https://a.example/rust',
        ['rust', 'ownership'],
        'deterministic',
        100,
      );
    } finally {
      index.close();
    }
    process.env[NEW_LABEL_HINT_ENV] = '0';
    const hint = await newLabelHintForPage(vaultRoot, 'https://a.example/rust');
    expect(hint).toBeNull();
  });

  sqliteIt('reuses the SAME handle across repeated calls for one vault (lazy singleton)', async () => {
    const index = await createKeywordIndexStore(vaultRoot);
    try {
      index.upsertPageKeywords(
        'url:https://a.example/rust',
        ['rust', 'ownership'],
        'deterministic',
        100,
      );
    } finally {
      index.close();
    }
    const first = await newLabelHintForPage(vaultRoot, 'https://a.example/rust');
    const second = await newLabelHintForPage(vaultRoot, 'https://a.example/rust');
    expect(first).toEqual(second);
  });
});
