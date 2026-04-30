import { describe, expect, it } from 'vitest';

import {
  normaliseForMatch,
  tryLinkCapturedThread,
  type DispatchLinkInput,
} from '../../src/companion/dispatchLinking';
import type { DispatchEventRecord } from '../../src/dispatch/types';

const NOW_MS = Date.parse('2026-04-30T12:00:00.000Z');

const buildDispatch = (overrides: Partial<DispatchEventRecord> = {}): DispatchEventRecord => ({
  bac_id: 'bac_disp_1',
  kind: 'research',
  target: { provider: 'gemini', mode: 'paste' },
  sourceThreadId: 'bac_thread_src',
  title: 'Pro-Questions',
  body:
    '# Research request: Pro-Questions - Binance Agentic AI Wallet\n\n## Source\nClaude · …',
  createdAt: '2026-04-30T11:55:00.000Z',
  redactionSummary: { matched: 0, categories: [] },
  tokenEstimate: 100,
  status: 'sent',
  ...overrides,
});

const baseInput = (overrides: Partial<DispatchLinkInput> = {}): DispatchLinkInput => ({
  threadId: 'bac_thread_dest',
  threadProvider: 'gemini',
  userTurnTexts: [],
  capturedAtMs: NOW_MS,
  recentDispatches: [],
  existingLinks: {},
  ...overrides,
});

describe('tryLinkCapturedThread', () => {
  it('returns null when there are no captured user turns', () => {
    const out = tryLinkCapturedThread(
      baseInput({ recentDispatches: [buildDispatch()] }),
    );
    expect(out).toBeNull();
  });

  it('matches when the dispatch body prefix appears in a user turn', () => {
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [
          dispatch.body, // user pasted the whole packet
        ],
        recentDispatches: [dispatch],
      }),
    );
    expect(out).toEqual({ dispatchId: dispatch.bac_id, matchedTurnIndex: 0 });
  });

  it('matches when the user pastes only a slightly modified prefix', () => {
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [
          // User edited a few chars at the start but the prefix still
          // appears further in.
          `Hi! Quick context:\n\n${dispatch.body}`,
        ],
        recentDispatches: [dispatch],
      }),
    );
    expect(out?.dispatchId).toBe(dispatch.bac_id);
  });

  it('rejects a dispatch on a different provider', () => {
    const dispatch = buildDispatch({ target: { provider: 'claude', mode: 'paste' } });
    const out = tryLinkCapturedThread(
      baseInput({
        threadProvider: 'gemini',
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
      }),
    );
    expect(out).toBeNull();
  });

  it('rejects a dispatch older than the 30-minute window', () => {
    const dispatch = buildDispatch({
      createdAt: new Date(NOW_MS - 31 * 60 * 1000).toISOString(),
    });
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
      }),
    );
    expect(out).toBeNull();
  });

  it('rejects a dispatch already linked to a different thread', () => {
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
        existingLinks: { [dispatch.bac_id]: 'bac_thread_OTHER' },
      }),
    );
    expect(out).toBeNull();
  });

  it('allows re-linking when the existing link points to the SAME thread (idempotent)', () => {
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
        existingLinks: { [dispatch.bac_id]: 'bac_thread_dest' },
      }),
    );
    expect(out?.dispatchId).toBe(dispatch.bac_id);
  });

  it('picks the most recent matching dispatch when multiple are eligible', () => {
    const older = buildDispatch({
      bac_id: 'older',
      createdAt: '2026-04-30T11:30:00.000Z',
    });
    const newer = buildDispatch({
      bac_id: 'newer',
      createdAt: '2026-04-30T11:58:00.000Z',
    });
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [older.body],
        recentDispatches: [older, newer],
      }),
    );
    expect(out?.dispatchId).toBe('newer');
  });

  it('skips dispatches with a body that normalises to less than the safety floor', () => {
    const tiny = buildDispatch({ body: 'hi' });
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: ['hi'],
        recentDispatches: [tiny],
      }),
    );
    expect(out).toBeNull();
  });

  it('falls back to a longer dispatch when a tiny one would also match', () => {
    const tiny = buildDispatch({ bac_id: 'tiny', body: 'hi' });
    const real = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [real.body],
        recentDispatches: [tiny, real],
      }),
    );
    expect(out?.dispatchId).toBe(real.bac_id);
  });
});

describe('normaliseForMatch', () => {
  it('strips punctuation and collapses whitespace', () => {
    expect(normaliseForMatch('Hello,   World!\nFoo.')).toBe('hello world foo');
  });

  it('keeps unicode letters/numbers', () => {
    expect(normaliseForMatch('café 42 — résumé')).toBe('café 42 résumé');
  });
});
