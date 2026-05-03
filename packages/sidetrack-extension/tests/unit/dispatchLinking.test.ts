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
  body: '# Research request: Pro-Questions - Binance Agentic AI Wallet\n\n## Source\nClaude · …',
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
    const out = tryLinkCapturedThread(baseInput({ recentDispatches: [buildDispatch()] }));
    expect(out).toMatchObject({ matched: false, reason: 'no-prefix-match' });
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
    expect(out).toMatchObject({
      matched: true,
      dispatchId: dispatch.bac_id,
      matchedTurnIndex: 0,
    });
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
    expect(out).toMatchObject({ matched: true, dispatchId: dispatch.bac_id });
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
    expect(out).toMatchObject({ matched: false, reason: 'provider-mismatch' });
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
    expect(out).toMatchObject({ matched: false, reason: 'window-expired' });
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
    expect(out).toMatchObject({ matched: false, reason: 'already-linked' });
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
    expect(out).toMatchObject({ matched: true, dispatchId: dispatch.bac_id });
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
    expect(out).toMatchObject({ matched: true, dispatchId: 'newer' });
  });

  it('skips dispatches with a body that normalises to less than the safety floor', () => {
    const tiny = buildDispatch({ body: 'hi' });
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: ['hi'],
        recentDispatches: [tiny],
      }),
    );
    expect(out).toMatchObject({ matched: false, reason: 'tiny-prefix' });
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
    expect(out).toMatchObject({ matched: true, dispatchId: real.bac_id });
  });

  it('matches against the unredacted ORIGINAL body when the redacted form would not', () => {
    // Regression guard: companion stores `body` in redacted form
    // (PII / API keys → `[email]`, `[anthropic-key]`). The user
    // pasted the unredacted form into the chat. Without
    // originalBodiesById, the redacted prefix can't substring-match
    // the captured turn, and the link silently misses.
    const dispatch = buildDispatch({
      bac_id: 'bac_disp_redacted',
      // Redacted version stored on the companion side.
      body: '# Research request: Pro-Questions [email]\n\n## Source\nClaude · …',
    });
    const originalBody =
      '# Research request: Pro-Questions user@example.com\n\n## Source\nClaude · …';
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [originalBody],
        recentDispatches: [dispatch],
        originalBodiesById: { bac_disp_redacted: originalBody },
      }),
    );
    expect(out).toMatchObject({ matched: true, dispatchId: 'bac_disp_redacted' });
  });

  it('falls back to the stored body when no original is cached', () => {
    // Older dispatches predating the originals cache should still
    // link (just less reliably). The matcher must NOT crash when
    // originalBodiesById is absent.
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
        // originalBodiesById intentionally omitted.
      }),
    );
    expect(out).toMatchObject({ matched: true, dispatchId: dispatch.bac_id });
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
