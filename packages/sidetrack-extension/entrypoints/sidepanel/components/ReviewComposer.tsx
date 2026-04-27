import { useState } from 'react';
import { Icons } from './icons';

export type ReviewVerdict = 'agree' | 'disagree' | 'partial' | 'needs_source' | 'open';

export interface ReviewSpan {
  readonly id: string;
  readonly text: string;
  readonly capturedAt?: string;
}

export interface ReviewComposerProps {
  readonly provider: string;
  readonly capturedAt: string;
  readonly spans: readonly ReviewSpan[];
  readonly defaultVerdict?: ReviewVerdict;
  readonly onClose: () => void;
  readonly onSave: (review: {
    verdict: ReviewVerdict;
    reviewerNote: string;
    perSpan: Record<string, string>;
  }) => void;
  readonly onSubmitBack: () => void;
  readonly onDispatchOut: () => void;
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
  defaultVerdict = 'partial',
  onClose,
  onSave,
  onSubmitBack,
  onDispatchOut,
}: ReviewComposerProps) {
  const [verdict, setVerdict] = useState<ReviewVerdict>(defaultVerdict);
  const [reviewerNote, setReviewerNote] = useState('');
  const [perSpan, setPerSpan] = useState<Record<string, string>>({});

  const handleSave = () => {
    onSave({ verdict, reviewerNote, perSpan });
  };

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

        <div className="review-hint">
          <em>
            Saving this review will be visible later in <code className="mono">_BAC/reviews/</code>{' '}
            and in déjà-vu surfacing.
          </em>
        </div>
      </div>

      <div className="review-foot">
        <button type="button" className="btn btn-ghost" onClick={handleSave}>
          Save review only
        </button>
        <div className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onSubmitBack}>
          Submit-back to {provider}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDispatchOut}>
          Dispatch to…
        </button>
      </div>
    </div>
  );
}
