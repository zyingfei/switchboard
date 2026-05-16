/**
 * @vitest-environment jsdom
 *
 * Zero-regression guarantee: when Mozilla Readability declines (returns `null`
 * or throws — common on SPAs, paywalls, and non-article pages), the ensemble
 * must degrade to exactly the prior single-strategy behavior (legacy
 * reader-mode heuristic, else visible-dom). Readability is mocked here so the
 * decline path is exercised deterministically rather than depending on the
 * library's heuristics under jsdom.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const parseMock = vi.fn<() => unknown>();

vi.mock('@mozilla/readability', () => ({
  Readability: class {
    parse(): unknown {
      return parseMock();
    }
  },
}));

import {
  PAGE_INDEX_SETTLE_TIMEOUT_MS,
  settleAndExtractPageContent,
} from '../../../src/pageContent/extraction';

const articleBody = (paragraphs: number): string =>
  Array.from(
    { length: paragraphs },
    (_, index) =>
      `<p>Paragraph ${String(index)} covers the incident retro in depth, ` +
      'including the detection gap, the mitigation timeline, and the ' +
      'follow-up action items the team committed to before the next review.</p>',
  ).join('');

// jsdom does not implement `HTMLElement.innerText` (returns undefined). The
// visible-dom fallback reads `document.body.innerText`, so without a shim that
// branch is unreachable under jsdom — a test-environment gap, not a code path
// difference. Mirror a real browser by falling back to `textContent`.
const innerTextDescriptor = Object.getOwnPropertyDescriptor(
  globalThis.HTMLElement.prototype,
  'innerText',
);
beforeAll(() => {
  Object.defineProperty(globalThis.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
});
afterAll(() => {
  if (innerTextDescriptor === undefined) {
    delete (globalThis.HTMLElement.prototype as { innerText?: unknown }).innerText;
  } else {
    Object.defineProperty(globalThis.HTMLElement.prototype, 'innerText', innerTextDescriptor);
  }
});

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

afterEach(() => {
  document.body.innerHTML = '';
  parseMock.mockReset();
});

describe('settleAndExtractPageContent — Readability-declines fallback', () => {
  it('degrades to the legacy reader-mode heuristic when Readability returns null', async () => {
    parseMock.mockReturnValue(null);
    // <article> present: the prior heuristic (pickReaderElement) still wins
    // exactly as before the ensemble existed.
    document.body.innerHTML = `<article><h1>Retro</h1>${articleBody(10)}</article>`;

    const result = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(parseMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.qualitySignals.extractionStrategy).toBe('reader-mode');
    expect(result.payload.content.text).toContain('covers the incident retro in depth');
  });

  it('degrades to visible-dom when Readability returns null and no article markup exists', async () => {
    parseMock.mockReturnValue(null);
    // No article/main/section/.content so the legacy heuristic returns null —
    // the pipeline must fall back to visible-dom, the original default.
    document.body.innerHTML = `<div>${articleBody(10)}</div>`;

    const result = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.qualitySignals.extractionStrategy).toBe('visible-dom');
    expect(result.payload.content.text).toContain('covers the incident retro in depth');
  });

  it('degrades safely when Readability throws', async () => {
    parseMock.mockImplementation(() => {
      throw new Error('readability blew up');
    });
    document.body.innerHTML = `<article><h1>Retro</h1>${articleBody(8)}</article>`;

    const result = await settleAndExtract({ mode: 'page', trigger: 'manual' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.qualitySignals.extractionStrategy).toBe('reader-mode');
    expect(result.payload.content.text).toContain('covers the incident retro in depth');
  });
});
