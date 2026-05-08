import { useState, type ReactElement } from 'react';

export type FeedbackChoice = 'confirm' | 'reject';

export interface FeedbackSubmitResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface FeedbackButtonsProps {
  readonly label?: string;
  readonly disabled?: boolean;
  readonly onFeedback: (
    choice: FeedbackChoice,
  ) => FeedbackSubmitResult | Promise<FeedbackSubmitResult | void> | void;
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ThumbsUpIcon = (
  <svg {...iconProps} aria-hidden>
    <path d="M7 10v10" />
    <path d="M7 10 12 3c.8-1 2.4-.5 2.4.8V8h4.2c1.5 0 2.5 1.4 2.1 2.8l-1.6 6.5c-.3 1-1.2 1.7-2.2 1.7H10c-1.7 0-3-1.3-3-3v-6z" />
    <path d="M3 10h4v10H3z" />
  </svg>
);

const ThumbsDownIcon = (
  <svg {...iconProps} aria-hidden>
    <path d="M7 14V4" />
    <path d="m7 14 5 7c.8 1 2.4.5 2.4-.8V16h4.2c1.5 0 2.5-1.4 2.1-2.8l-1.6-6.5c-.3-1-1.2-1.7-2.2-1.7H10C8.3 5 7 6.3 7 8v6z" />
    <path d="M3 4h4v10H3z" />
  </svg>
);

export const FeedbackButtons = ({
  label = 'connection',
  disabled = false,
  onFeedback,
}: FeedbackButtonsProps): ReactElement => {
  const [pending, setPending] = useState<FeedbackChoice | null>(null);
  const [selected, setSelected] = useState<FeedbackChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (choice: FeedbackChoice): void => {
    setPending(choice);
    setError(null);
    void Promise.resolve(onFeedback(choice))
      .then((result) => {
        if (result !== undefined && !result.ok) {
          setError(result.error ?? 'feedback failed');
          return;
        }
        setSelected(choice);
      })
      .catch((submitError: unknown) => {
        setError(submitError instanceof Error ? submitError.message : String(submitError));
      })
      .finally(() => {
        setPending(null);
      });
  };

  const busy = pending !== null;
  return (
    <div
      data-testid="feedback-buttons"
      style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
    >
      <button
        type="button"
        className="cx-icon-button"
        aria-label={`Confirm ${label}`}
        aria-pressed={selected === 'confirm'}
        disabled={disabled || busy}
        onClick={() => submit('confirm')}
        data-testid="feedback-confirm"
        title={`Confirm ${label}`}
        style={selected === 'confirm' ? { color: 'var(--signal)' } : undefined}
      >
        {pending === 'confirm' ? '...' : ThumbsUpIcon}
      </button>
      <button
        type="button"
        className="cx-icon-button"
        aria-label={`Reject ${label}`}
        aria-pressed={selected === 'reject'}
        disabled={disabled || busy}
        onClick={() => submit('reject')}
        data-testid="feedback-reject"
        title={`Reject ${label}`}
        style={selected === 'reject' ? { color: 'var(--danger)' } : undefined}
      >
        {pending === 'reject' ? '...' : ThumbsDownIcon}
      </button>
      {error !== null ? (
        <span className="cx-mono cx-dim" role="status" data-testid="feedback-error">
          {error}
        </span>
      ) : selected !== null ? (
        <span className="cx-mono cx-dim" role="status" data-testid="feedback-saved">
          saved
        </span>
      ) : null}
    </div>
  );
};
