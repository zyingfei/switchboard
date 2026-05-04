import { describe, expect, it } from 'vitest';

import { buildReviewFollowUpText } from '../../src/review/draft';
import type { ReviewDraft } from '../../src/review/types';

const baseAnchor = {
  textQuote: { exact: '', prefix: '', suffix: '' },
  textPosition: { start: 0, end: 0 },
  cssSelector: 'body',
};

const draftFixture = (overrides: Partial<ReviewDraft> = {}): ReviewDraft => ({
  threadId: 'bac_thread_1',
  threadUrl: 'https://gemini.google.com/app/abc',
  spans: [],
  updatedAt: '2026-05-04T12:00:00.000Z',
  ...overrides,
});

describe('buildReviewFollowUpText', () => {
  it('quotes each span and asks the AI to address them', () => {
    const draft = draftFixture({
      spans: [
        {
          bac_id: 'sp_1',
          threadUrl: 'https://gemini.google.com/app/abc',
          anchor: baseAnchor,
          quote: 'Standard check-in time for Hyatt is 3pm.',
          comment: 'Discoverist members can usually get in at 8am with a request.',
          capturedAt: '2026-05-04T12:00:00.000Z',
        },
      ],
    });
    const out = buildReviewFollowUpText(draft);
    expect(out).toContain('A few notes on the previous response');
    expect(out).toContain('> Standard check-in time for Hyatt is 3pm.');
    expect(out).toContain('— Discoverist members can usually get in at 8am with a request.');
    expect(out).toContain('Could you address these specifically?');
    expect(out).not.toContain('Overall:');
    expect(out).not.toContain('My read:');
  });

  it('caps the quote at 200 chars with an ellipsis', () => {
    const longQuote = 'a'.repeat(250);
    const draft = draftFixture({
      spans: [
        {
          bac_id: 'sp_1',
          threadUrl: 'https://gemini.google.com/app/abc',
          anchor: baseAnchor,
          quote: longQuote,
          comment: 'too verbose',
          capturedAt: '2026-05-04T12:00:00.000Z',
        },
      ],
    });
    const out = buildReviewFollowUpText(draft);
    expect(out).toContain(`> ${'a'.repeat(200)}…`);
    expect(out).not.toContain('a'.repeat(201));
  });

  it('appends overall note when set', () => {
    const draft = draftFixture({
      spans: [
        {
          bac_id: 'sp_1',
          threadUrl: 'https://gemini.google.com/app/abc',
          anchor: baseAnchor,
          quote: 'q',
          comment: 'c',
          capturedAt: '2026-05-04T12:00:00.000Z',
        },
      ],
      overall: 'The whole answer skipped the elite-status angle.',
    });
    const out = buildReviewFollowUpText(draft);
    expect(out).toContain('Overall: The whole answer skipped the elite-status angle.');
  });

  it('renders verdict in plain English', () => {
    const draft = draftFixture({
      spans: [
        {
          bac_id: 'sp_1',
          threadUrl: 'https://gemini.google.com/app/abc',
          anchor: baseAnchor,
          quote: 'q',
          comment: 'c',
          capturedAt: '2026-05-04T12:00:00.000Z',
        },
      ],
      verdict: 'partial',
    });
    const out = buildReviewFollowUpText(draft);
    expect(out).toContain('(My read: partially agree)');
  });

  it('drops empty overall (whitespace-only) silently', () => {
    const draft = draftFixture({
      spans: [
        {
          bac_id: 'sp_1',
          threadUrl: 'https://gemini.google.com/app/abc',
          anchor: baseAnchor,
          quote: 'q',
          comment: 'c',
          capturedAt: '2026-05-04T12:00:00.000Z',
        },
      ],
      overall: '   ',
    });
    const out = buildReviewFollowUpText(draft);
    expect(out).not.toContain('Overall:');
  });
});
