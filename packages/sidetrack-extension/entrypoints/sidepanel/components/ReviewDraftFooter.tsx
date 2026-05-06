import { useState } from 'react';
import type { ReviewDraft, ReviewVerdict } from '../../../src/review/types';

// Inline-review draft footer — surfaces under a thread row when the
// user has staged comments via on-page selection (see content script
// + mountReviewSelectionChip). Lists every staged span, the overall
// note, an optional verdict, and the three actions (Send as follow-
// up / Save to vault only / Discard).
//
// Keeps no internal state for the spans + verdict — they live in
// chrome.storage.local under sidetrack.reviewDrafts and reach this
// component via the workboard state. Local state is only the
// "overall" textarea so onChange typing doesn't round-trip through
// the background per keystroke.
//
// When the companion projection reports a register conflict (two
// peers edited the same field concurrently), `draft.conflicts`
// carries the candidates and the footer renders a small picker.
// Resolution writes a normal mutation; the next projection pass
// causally dominates the candidates and clears the conflict.

export interface ReviewDraftFooterProps {
  readonly draft: ReviewDraft;
  readonly onDropSpan: (spanId: string) => void;
  readonly onUpdate: (patch: { overall?: string; verdict?: ReviewVerdict }) => void;
  readonly onSetSpanComment: (spanId: string, comment: string) => void;
  // Add to queue without firing auto-send. The user can keep building
  // up follow-ups and trigger the drain explicitly via the per-thread
  // auto-send chip when they're ready.
  readonly onAddToQueue: () => void;
  // Queue + flip auto-send on so the AI gets the prompt immediately.
  readonly onSendNow: () => void;
  readonly onDiscard: () => void;
}

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  agree: 'Agree',
  disagree: 'Disagree',
  partial: 'Partial',
  needs_source: 'Needs source',
  open: 'Open',
};

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;

interface ConflictBannerProps<T> {
  readonly label: string;
  readonly candidates: readonly T[];
  readonly renderValue: (value: T) => string;
  readonly onPick: (value: T) => void;
}

function ConflictBanner<T>({
  label,
  candidates,
  renderValue,
  onPick,
}: ConflictBannerProps<T>) {
  return (
    <div className="review-draft-conflict mono">
      <span className="review-draft-conflict-label">
        {label} has {String(candidates.length)} versions:
      </span>
      <div className="review-draft-conflict-candidates">
        {candidates.map((candidate, index) => {
          const display = renderValue(candidate);
          return (
            <button
              key={`${String(index)}-${display}`}
              type="button"
              className="btn-link review-draft-conflict-pick"
              title={display}
              onClick={() => {
                onPick(candidate);
              }}
            >
              Use “{truncate(display, 80)}”
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ReviewDraftFooter({
  draft,
  onDropSpan,
  onUpdate,
  onSetSpanComment,
  onAddToQueue,
  onSendNow,
  onDiscard,
}: ReviewDraftFooterProps) {
  const [overallDraft, setOverallDraft] = useState(draft.overall ?? '');
  const verdict = draft.verdict;
  const canSend = draft.spans.length > 0;

  const overallConflict = draft.conflicts?.overall;
  const verdictConflict = draft.conflicts?.verdict;
  const commentConflicts = draft.conflicts?.comments ?? {};

  return (
    <div className="review-draft-footer">
      <div className="review-draft-spans">
        {draft.spans.map((span) => {
          const conflict = commentConflicts[span.bac_id];
          return (
            <div key={span.bac_id} className="review-draft-span">
              <div className="review-draft-quote">
                <span className="review-draft-quote-text">{truncate(span.quote, 200)}</span>
                <button
                  type="button"
                  className="btn-link review-draft-drop"
                  title="Drop this comment"
                  aria-label="Drop comment"
                  onClick={() => {
                    onDropSpan(span.bac_id);
                  }}
                >
                  ✕
                </button>
              </div>
              {conflict !== undefined && conflict.candidates.length > 1 ? (
                <ConflictBanner
                  label="Comment"
                  candidates={conflict.candidates}
                  renderValue={(value) => value}
                  onPick={(value) => {
                    onSetSpanComment(span.bac_id, value);
                  }}
                />
              ) : null}
              <div className="review-draft-comment">{span.comment}</div>
            </div>
          );
        })}
      </div>

      {overallConflict !== undefined && overallConflict.candidates.length > 1 ? (
        <ConflictBanner
          label="Overall"
          candidates={overallConflict.candidates}
          renderValue={(value) => value}
          onPick={(value) => {
            setOverallDraft(value);
            onUpdate({ overall: value });
          }}
        />
      ) : null}

      <label className="review-draft-overall-label mono">overall</label>
      <textarea
        className="review-draft-overall"
        rows={2}
        placeholder="(optional) one-sentence summary of what this response should fix"
        value={overallDraft}
        onChange={(event) => {
          setOverallDraft(event.target.value);
        }}
        onBlur={() => {
          if (overallDraft !== (draft.overall ?? '')) {
            onUpdate({ overall: overallDraft });
          }
        }}
      />

      {verdictConflict !== undefined && verdictConflict.candidates.length > 1 ? (
        <ConflictBanner
          label="Verdict"
          candidates={verdictConflict.candidates}
          renderValue={(value) => VERDICT_LABELS[value]}
          onPick={(value) => {
            onUpdate({ verdict: value });
          }}
        />
      ) : null}

      <div className="review-draft-verdict-row">
        <span className="mono review-draft-verdict-label">verdict</span>
        <div className="review-draft-verdict-pills">
          {(Object.keys(VERDICT_LABELS) as readonly ReviewVerdict[]).map((key) => (
            <button
              key={key}
              type="button"
              className={'verdict verdict-' + key + (verdict === key ? ' on' : '')}
              onClick={() => {
                onUpdate({ verdict: verdict === key ? undefined : key });
              }}
            >
              {VERDICT_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      <div className="review-draft-actions">
        <button
          type="button"
          className="btn-link review-draft-discard"
          onClick={onDiscard}
          title="Throw the draft away"
        >
          Discard
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn-link review-draft-queue"
          onClick={onAddToQueue}
          disabled={!canSend}
          title="Queue this as a follow-up. Auto-send stays as-is — flip the per-thread chip when you're ready to ship."
        >
          Add to queue
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={onSendNow}
          disabled={!canSend}
          title="Queue this as a follow-up and turn auto-send on so the AI gets it immediately"
        >
          Send now
        </button>
      </div>
    </div>
  );
}
