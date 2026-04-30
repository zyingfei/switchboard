import { useState } from 'react';
import { Icons } from './icons';

// Verdict is a side-channel signal — useful for analytics + déjà-vu
// surfacing later, but it should NOT be the primary input. The
// reviewer's words are. Verdict UI is collapsed by default; clicking
// "Add verdict" opens it. Five values, no default.
export type ReviewVerdict = 'agree' | 'disagree' | 'partial' | 'needs_source' | 'open';

export interface ReviewSpan {
  readonly id: string;
  readonly text: string;
  readonly capturedAt?: string;
}

export interface ReviewPayload {
  readonly verdict: ReviewVerdict | null;
  readonly reviewerNote: string;
  readonly perSpan: Record<string, string>;
  // The (possibly user-edited) text of each span. Lets reviewers
  // correct a transcription glitch or trim a span before sending the
  // review back to the chat.
  readonly spanText: Record<string, string>;
}

export interface ReviewComposerProps {
  readonly provider: string;
  readonly capturedAt: string;
  readonly spans: readonly ReviewSpan[];
  readonly defaultVerdict?: ReviewVerdict;
  readonly onClose: () => void;
  readonly onSave: (review: ReviewPayload) => void;
  // Send the review as a follow-up reply into the same provider chat.
  // Wires through the auto-send drain we already built — no
  // round-trip through the dispatch confirm modal for this path.
  readonly onSendBack: (review: ReviewPayload) => void;
  // Dispatch this review as a packet to a different provider —
  // bounces through DispatchConfirm. Optional; omitting hides the
  // affordance entirely.
  readonly onDispatchOut?: (review: ReviewPayload) => void;
}

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  agree: 'Agree',
  disagree: 'Disagree',
  partial: 'Partial',
  needs_source: 'Needs source',
  open: 'Open',
};

export function ReviewComposer({
  provider,
  capturedAt,
  spans,
  defaultVerdict,
  onClose,
  onSave,
  onSendBack,
  onDispatchOut,
}: ReviewComposerProps) {
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(defaultVerdict ?? null);
  const [reviewerNote, setReviewerNote] = useState('');
  const [perSpan, setPerSpan] = useState<Record<string, string>>({});
  const [spanText, setSpanText] = useState<Record<string, string>>(() =>
    Object.fromEntries(spans.map((s) => [s.id, s.text])),
  );
  // Verdict pills are hidden behind a click — they're a side-channel
  // signal, not the main event. Reviewers who want to flag agree /
  // disagree can; reviewers who want to leave a comment shouldn't be
  // forced to take a stance.
  const [verdictOpen, setVerdictOpen] = useState(defaultVerdict !== undefined);

  const buildPayload = (): ReviewPayload => ({
    verdict,
    reviewerNote,
    perSpan,
    spanText,
  });

  // Save is always safe. Send-back ships into the same chat — primary
  // when there's any comment to send. Dispatch-out is the escape hatch
  // for fan-out reviews.
  const hasAnyComment =
    reviewerNote.trim().length > 0 ||
    Object.values(perSpan).some((c) => c.trim().length > 0);

  return (
    <div className="review-composer">
      <div className="review-head">
        <div className="review-head-text">
          <h3>Review</h3>
          <div className="review-sub mono">
            {provider} · captured {capturedAt} · {spans.length} span{spans.length === 1 ? '' : 's'}
          </div>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <span className="icon-12">{Icons.close}</span>
        </button>
      </div>

      {/* Two-column layout: captured spans on the left (editable
          inline), reviewer's comments on the right. The visual
          alignment teaches "this comment goes with that span." */}
      <div className="review-body review-body-split">
        <div className="review-spans-col">
          {spans.map((span, index) => (
            <div key={span.id} className="review-span-card">
              <div className="review-span-meta mono">
                #{index + 1} · {provider} · {span.capturedAt ?? capturedAt}
              </div>
              <textarea
                className="review-span-text"
                value={spanText[span.id] ?? span.text}
                onChange={(event) => {
                  setSpanText((prev) => ({ ...prev, [span.id]: event.target.value }));
                }}
                title="Edit the captured text inline — the edited version is what gets sent back"
              />
            </div>
          ))}
        </div>
        <div className="review-comments-col">
          {spans.map((span, index) => (
            <div key={span.id} className="review-comment-card">
              <label className="mono review-comment-label">
                comment on #{index + 1}
              </label>
              <textarea
                className="review-comment-text"
                placeholder="What's right, what's wrong, what needs more…"
                value={perSpan[span.id] ?? ''}
                onChange={(event) => {
                  setPerSpan((prev) => ({ ...prev, [span.id]: event.target.value }));
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="review-overall">
        <label className="mono review-comment-label">overall note (optional)</label>
        <textarea
          className="review-overall-text"
          value={reviewerNote}
          onChange={(event) => {
            setReviewerNote(event.target.value);
          }}
          placeholder="One-liner that ties the per-span comments together…"
        />
      </div>

      {/* Verdict tucked into a collapsed disclosure. Five values, no
          pre-selected default. Don't force a stance — the comment is
          the review. */}
      <div className="review-verdict-disclosure">
        {!verdictOpen && verdict === null ? (
          <button
            type="button"
            className="btn-link mono"
            onClick={() => {
              setVerdictOpen(true);
            }}
          >
            + add verdict (optional)
          </button>
        ) : (
          <div className="review-verdict-row">
            <span className="mono review-verdict-label">verdict</span>
            <div className="verdict-row">
              {(Object.keys(VERDICT_LABELS) as readonly ReviewVerdict[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={'verdict verdict-' + key + (verdict === key ? ' on' : '')}
                  onClick={() => {
                    setVerdict(verdict === key ? null : key);
                  }}
                >
                  {VERDICT_LABELS[key]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="review-hint">
        <em>
          Reviews land in <code className="mono">_BAC/reviews/</code>. Send-back composes the
          comments into a follow-up reply for the same {provider} chat.
        </em>
      </div>

      <div className="review-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <div className="spacer" />
        {onDispatchOut !== undefined ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onDispatchOut(buildPayload());
            }}
            disabled={!hasAnyComment}
            title={
              hasAnyComment
                ? 'Send this review as a packet to a different AI'
                : 'Add a comment before dispatching to another AI'
            }
          >
            Dispatch to other AI…
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            onSave(buildPayload());
          }}
          title="Save the review locally + to the vault, no chat reply"
        >
          Save only
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onSendBack(buildPayload());
          }}
          disabled={!hasAnyComment}
          title={
            hasAnyComment
              ? `Save and send the comments as a follow-up into this ${provider} chat`
              : 'Add a comment before sending back to the chat'
          }
        >
          <span className="icon-12">{Icons.send}</span> Send back to {provider}
        </button>
      </div>
    </div>
  );
}
