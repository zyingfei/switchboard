import { useState } from 'react';
import { Icons } from './icons';

export type ReviewVerdict = 'agree' | 'disagree' | 'partial' | 'needs_source' | 'open';

export interface ReviewSpan {
  readonly id: string;
  readonly text: string;
  readonly capturedAt?: string;
}

export interface ReviewPayload {
  readonly verdict: ReviewVerdict;
  readonly reviewerNote: string;
  readonly perSpan: Record<string, string>;
}

export interface ReviewComposerProps {
  readonly provider: string;
  readonly capturedAt: string;
  readonly spans: readonly ReviewSpan[];
  readonly defaultVerdict?: ReviewVerdict;
  readonly onClose: () => void;
  readonly onSave: (review: ReviewPayload) => void;
  // Both action handlers now receive the live form state — previously
  // SubmitBack and DispatchOut threw away whatever the user typed and
  // shipped synthetic placeholders, which is a correctness bug dressed
  // as a UX issue.
  readonly onSubmitBack: (review: ReviewPayload) => void;
  readonly onDispatchOut: (review: ReviewPayload) => void;
}

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  agree: 'Agree',
  disagree: 'Disagree',
  partial: 'Partial',
  needs_source: 'Needs source',
  open: 'Open',
};

/**
 * Inline review composer for §28 — annotate spans of an assistant turn.
 *
 * Distinct from the packet system: reviews ANNOTATE a captured turn;
 * packets BUNDLE context for handoff. Don't conflate.
 *
 * Three actions:
 * - Save review only (records ReviewEvent, no dispatch)
 * - Submit-back (composes follow-up turn into the same chat — paste-mode locked per Q5)
 * - Dispatch-out (multi-target dispatch, routes through DispatchConfirm)
 */
export function ReviewComposer({
  provider,
  capturedAt,
  spans,
  // No default verdict — reviewer should pick. Pre-selecting 'partial'
  // biased every review toward "kinda right." Caller can still pass
  // one explicitly via defaultVerdict when there's a real reason to.
  defaultVerdict,
  onClose,
  onSave,
  onSubmitBack,
  onDispatchOut,
}: ReviewComposerProps) {
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(defaultVerdict ?? null);
  const [reviewerNote, setReviewerNote] = useState('');
  const [perSpan, setPerSpan] = useState<Record<string, string>>({});

  // Build the live payload at click-time so all three actions ship the
  // user's actual state (Submit-back was previously throwing it away).
  const buildPayload = (): ReviewPayload => ({
    verdict: verdict ?? 'open',
    reviewerNote,
    perSpan,
  });
  const handleSave = () => {
    onSave(buildPayload());
  };
  const handleSubmitBack = () => {
    onSubmitBack(buildPayload());
  };
  const handleDispatchOut = () => {
    onDispatchOut(buildPayload());
  };

  // Save is the only terminal action that means "my review is recorded";
  // Submit-back and Dispatch-out both bundle a record with a side
  // effect (write into the chat / dispatch to another AI). When the
  // user got interrupted, the visually-loudest button should be the
  // safe one.
  const noteEntered = reviewerNote.trim().length > 0;

  return (
    <div className="review-composer">
      <div className="review-head">
        <div className="review-head-text">
          <h3>Review — captured turn</h3>
          <div className="review-sub mono">
            {provider} · captured {capturedAt}
          </div>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <span className="icon-12">{Icons.close}</span>
        </button>
      </div>

      <div className="review-body">
        {/* Verdict first — it's the thesis. Note + per-span are the
            evidence that supports it. Reading order matches reviewing
            order, not the data-model order. */}
        <div className="review-field">
          <label>Verdict</label>
          <div className="verdict-row">
            {(Object.keys(VERDICT_LABELS) as readonly ReviewVerdict[]).map((key) => (
              <button
                key={key}
                type="button"
                className={'verdict verdict-' + key + (verdict === key ? ' on' : '')}
                onClick={() => {
                  setVerdict(key);
                }}
              >
                {VERDICT_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="review-field">
          <label>Reviewer note</label>
          <textarea
            value={reviewerNote}
            onChange={(event) => {
              setReviewerNote(event.target.value);
            }}
            placeholder="Overall: what's right, what's wrong, what needs more…"
          />
        </div>

        {spans.map((span, index) => (
          <div key={span.id} className="review-span">
            <blockquote className="span-quote">{span.text}</blockquote>
            <div className="span-meta mono">
              span {index + 1} · {provider} · {span.capturedAt ?? capturedAt}
            </div>
            <textarea
              className="span-comment"
              placeholder="Comment on this span…"
              value={perSpan[span.id] ?? ''}
              onChange={(event) => {
                setPerSpan({ ...perSpan, [span.id]: event.target.value });
              }}
            />
          </div>
        ))}

        <div className="review-hint">
          <em>
            Saving this review will be visible later in <code className="mono">_BAC/reviews/</code>{' '}
            and in déjà-vu surfacing.
          </em>
        </div>
      </div>

      <div className="review-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleSubmitBack}
          disabled={!noteEntered}
          title={
            noteEntered
              ? `Compose a follow-up reply into the same ${provider} chat`
              : 'Type a reviewer note before submitting back to the chat'
          }
        >
          Submit-back to {provider}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleDispatchOut}
          disabled={!noteEntered}
          title={
            noteEntered
              ? 'Dispatch this review as a packet to another AI'
              : 'Type a reviewer note before dispatching out'
          }
        >
          Dispatch to…
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          title="Record this review locally and to the vault. Always safe."
        >
          Save review
        </button>
      </div>
    </div>
  );
}
