/**
 * @vitest-environment jsdom
 *
 * Covers the in-architecture extraction ensemble added in
 * `src/pageContent/extraction.ts`:
 *  - the Mozilla Readability strategy extracts the article body and strips
 *    nav / header / footer / sidebar boilerplate on a fixture page;
 *  - the ensemble selects the candidate that maximizes the companion's
 *    quality tier (deterministic);
 *  - the prior single-strategy behavior is unchanged when Readability yields
 *    nothing (zero-regression fallback) and for the selection mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PAGE_INDEX_SETTLE_TIMEOUT_MS,
  settleAndExtractPageContent,
} from '../../../src/pageContent/extraction';

// A long article body so word-count / content-ratio thresholds are exercised
// the same way the companion's classifier (`classifyPageContentQuality`) sees
// them.
const articleBody = (paragraphs: number): string =>
  Array.from(
    { length: paragraphs },
    (_, index) =>
      `<p>Paragraph ${String(index)} discusses the migration plan in detail. ` +
      'It explains the rollout sequence, the rollback strategy, and the ' +
      'observability hooks that operators rely on during the change window. ' +
      'Each step is gated behind an explicit approval to keep the system safe.</p>',
  ).join('');

// Drive the MutationObserver/settle debounce + timeout deterministically so the
// test exercises real extraction without waiting on wall-clock timers.
const settleAndExtract = async (
  ...args: Parameters<typeof settleAndExtractPageContent>
): ReturnType<typeof settleAndExtractPageContent> => {
  vi.useFakeTimers();
  try {
    const pending = settleAndExtractPageContent(...args);
    await vi.advanceTimersByTimeAsync(PAGE_INDEX_SETTLE_TIMEOUT_MS + 100);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
};

// jsdom serves the default `http://localhost/` origin, which satisfies the
// extractor's http(s) protocol gate; no navigation is needed for these
// assertions (they target extracted text, quality signals, and strategy).
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('settleAndExtractPageContent — Readability strategy', () => {
  it('extracts the article body and strips nav/header/footer/sidebar boilerplate', async () => {
    document.body.innerHTML = `
      <nav><a href="/home">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
      <header>SiteName Global Header Banner Advertisement</header>
      <article><h1>Migration Runbook</h1>${articleBody(8)}</article>
      <footer>Copyright 2026 SiteName. All rights reserved. Privacy Terms Cookies</footer>
      <aside>Related links sidebar promo promo promo</aside>`;

    const result = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { content, qualitySignals, quality, extractionSource } = result.payload;

    // Article body retained.
    expect(content.text).toContain('discusses the migration plan in detail');
    // Boilerplate stripped by Readability.
    expect(content.text).not.toContain('About');
    expect(content.text).not.toContain('All rights reserved');
    expect(content.text).not.toContain('Related links sidebar');

    // Reported within the existing strategy union and high-tier eligible.
    expect(extractionSource).toBe('reader-mode');
    expect(qualitySignals.extractionStrategy).toBe('reader-mode');
    expect(qualitySignals.extractedWordCount).toBeGreaterThanOrEqual(300);
    expect(qualitySignals.contentToDomRatio).toBeGreaterThanOrEqual(0.4);
    expect(quality).toBe('high');
  });
});

describe('settleAndExtractPageContent — ensemble selection', () => {
  it('selects a high-tier Readability candidate over a boilerplate-padded visible-dom candidate', async () => {
    // Semantic <article> lets Readability isolate the body; the surrounding
    // nav/footer/aside noise is what a raw visible-dom candidate would drag in.
    // The ensemble must pick the higher-tier reader-mode candidate.
    document.body.innerHTML = `
      <nav>${'<a href="/x">Subscribe now</a>'.repeat(30)}</nav>
      <article><h1>Quarterly Findings</h1>${articleBody(10)}</article>
      <footer>${'Sponsored content. '.repeat(40)}</footer>`;

    const result = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reader-mode (Readability or the legacy heuristic, both report
    // 'reader-mode') beats visible-dom on quality tier here.
    expect(result.payload.qualitySignals.extractionStrategy).toBe('reader-mode');
    expect(result.payload.content.text).toContain('discusses the migration plan in detail');
    expect(result.payload.content.text).not.toContain('Subscribe now');
    expect(result.payload.content.text).not.toContain('Sponsored content.');
    // The selected candidate reached the companion's top tier.
    expect(result.payload.quality).toBe('high');
  });

  it('is deterministic across repeated runs on the same fixture', async () => {
    const fixture = `<article><h1>Stable</h1>${articleBody(9)}</article>`;
    document.body.innerHTML = fixture;
    const first = await settleAndExtract({ mode: 'page', trigger: 'manual' });
    document.body.innerHTML = fixture;
    const second = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.payload.content.contentHash).toBe(first.payload.content.contentHash);
    expect(second.payload.qualitySignals).toEqual(first.payload.qualitySignals);
  });
});

describe('settleAndExtractPageContent — zero-regression fallback', () => {
  it('keeps the manual-selection strategy untouched', async () => {
    document.body.innerHTML = `<article><h1>Doc</h1>${articleBody(6)}</article>`;
    const selected = 'This exact sentence was selected by the user for indexing.';
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => selected,
    } as unknown as Selection);

    const result = await settleAndExtract({ mode: 'selection', trigger: 'manual' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.qualitySignals.extractionStrategy).toBe('manual-selection');
    expect(result.payload.content.text).toBe(selected);
  });

  it('reports no readable text when the page and selection are empty', async () => {
    document.body.innerHTML = '';

    const result = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('No readable page text found.');
  });
});
