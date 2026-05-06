import { describe, expect, it } from 'vitest';

import type { DispatchEventRecord } from '../http/schemas.js';
import {
  normaliseForMatch,
  tryLinkCapturedThread,
  type DispatchLinkInput,
} from './correlation.js';

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
  it('returns no-prefix-match when there are no captured user turns', () => {
    const out = tryLinkCapturedThread(baseInput({ recentDispatches: [buildDispatch()] }));
    expect(out).toMatchObject({ matched: false, reason: 'no-prefix-match' });
  });

  it('matches when the dispatch body prefix appears in a user turn', () => {
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [dispatch.body],
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
        userTurnTexts: [`Hi! Quick context:\n\n${dispatch.body}`],
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

  it('allows re-linking when the existing link points to the SAME thread', () => {
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

  it('matches against the unredacted ORIGINAL body when the redacted form would not', () => {
    const dispatch = buildDispatch({
      bac_id: 'bac_disp_redacted',
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
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
      }),
    );
    expect(out).toMatchObject({ matched: true, dispatchId: dispatch.bac_id });
  });

  it('re-links across an orphaned destination thread (its old bac_id is gone)', () => {
    const dispatch = buildDispatch();
    const out = tryLinkCapturedThread(
      baseInput({
        threadId: 'bac_thread_new',
        userTurnTexts: [dispatch.body],
        recentDispatches: [dispatch],
        existingLinks: { [dispatch.bac_id]: 'bac_thread_old_orphan' },
        liveThreadIds: new Set(['bac_thread_new']),
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
