import { useEffect, useMemo, useState } from 'react';
import type { QueueItem } from '../../../src/workboard';

export interface AutoSendQueueRowProps {
  readonly item: QueueItem;
  readonly index: number;
  readonly total: number;
  readonly providerLabel: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function AutoSendQueueRow({
  item,
  index,
  total,
  providerLabel,
  copied,
  onCopy,
  onRetry,
  onDismiss,
}: AutoSendQueueRowProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (item.progress !== 'waiting') {
      return undefined;
    }
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(handle);
    };
  }, [item.progress]);

  const elapsedSeconds = useMemo(() => {
    const startedAt = Date.parse(item.updatedAt);
    if (Number.isNaN(startedAt)) {
      return 0;
    }
    return Math.max(0, Math.floor((now - startedAt) / 1000));
  }, [item.updatedAt, now]);

  const failed = item.lastError !== undefined;
  const active = !failed && item.progress !== undefined;
  const sent = item.status === 'done';
  const statusClass = failed ? 'failed' : sent ? 'sent' : active ? 'active' : 'queued';
  const glyph = failed ? '✕' : sent ? '✓' : active ? '◉' : '◯';
  const label = failed ? 'Failed' : sent ? 'Sent' : active ? 'Sending now' : 'Queued';
  const spinnerFrame = SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length];

  return (
    <li className={`queue-row ${statusClass}`}>
      <div className="queue-row-status mono" aria-hidden>
        {glyph}
      </div>
      <div className="queue-row-main">
        <div className="queue-row-head mono">
          <span>{label}</span>
          <span>· {String(index + 1)} of {String(total)}</span>
        </div>
        <div className="queue-row-text" title={item.text}>
          “{item.text}”
        </div>
        {item.progress === 'typing' ? (
          <div className="queue-row-phase mono" role="status">
            <span className="queue-row-spinner" aria-hidden>
              {spinnerFrame}
            </span>{' '}
            typing into {providerLabel}…
          </div>
        ) : null}
        {item.progress === 'waiting' ? (
          <div className="queue-row-phase mono" role="status">
            ⏳ waiting for {providerLabel}&apos;s reply · {String(elapsedSeconds)}s
          </div>
        ) : null}
        {failed ? (
          <div className="queue-row-error mono" title={item.lastError}>
            {item.lastError}
          </div>
        ) : null}
      </div>
      <div className="queue-row-actions">
        <button type="button" className="btn-link" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {failed ? (
          <button type="button" className="btn-link thread-queue-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        <button type="button" className="btn-link" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </li>
  );
}
