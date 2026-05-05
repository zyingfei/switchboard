import type { ReviewDraft } from './types';

const VERDICT_LABEL: Record<NonNullable<ReviewDraft['verdict']>, string> = {
  agree: 'agree',
  disagree: 'disagree',
  partial: 'partially agree',
  needs_source: 'needs sources',
  open: 'still open',
};

// Bundle a staged inline-review draft into a single follow-up prompt.
// Quotes each commented span (capped to 200 chars) followed by the
// user's comment, then folds in the overall note + verdict, so the
// AI sees the review as plain prose rather than Sidetrack-jargon.
// Pure function — no chrome / storage access — so it's safe for
// unit tests and reuse from any entrypoint.
export const buildReviewFollowUpText = (draft: ReviewDraft): string => {
  const lines: string[] = ['A few notes on the previous response:', ''];
  for (const span of draft.spans) {
    const quote = span.quote.length > 200 ? `${span.quote.slice(0, 200).trimEnd()}…` : span.quote;
    lines.push(`> ${quote}`);
    lines.push(`— ${span.comment.trim()}`);
    lines.push('');
  }
  if (draft.overall !== undefined && draft.overall.trim().length > 0) {
    lines.push(`Overall: ${draft.overall.trim()}`);
    lines.push('');
  }
  if (draft.verdict !== undefined) {
    lines.push(`(My read: ${VERDICT_LABEL[draft.verdict]})`);
    lines.push('');
  }
  lines.push('Could you address these specifically?');
  return lines.join('\n');
};
