import { useEffect, useRef, useState } from 'react';

import { companionStatusLabel, type CompanionStatus } from '../../../src/workboard';

// Connect-dot — the header's quiet health indicator. The old three-pill
// sp-status row (vault + companion + recall) collapses into ONE calm
// compound dot with a hover/click popover that expands to the preserved
// tri-state detail (down / local-only / busy / connected). Steady state
// = one dot + short label; the three-domain distinction is preserved on
// expand, never deleted. Error stays legible (rose dot + text) and
// routes to Settings#companion-connection. The dump-result chip lives
// in the popover too (keeping its data-testid=dump-result).

type RecallStatus = 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready' | null;
type DumpStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'dumping' }
  | { readonly kind: 'dumped'; readonly path: string }
  | { readonly kind: 'error'; readonly message: string };

export interface ConnectDotProps {
  readonly companionStatus: CompanionStatus;
  readonly recallStatus: RecallStatus;
  readonly dumpStatus: DumpStatus;
  readonly onClearDump: () => void;
  readonly onOpenConnectionSettings: () => void;
}

// Overall tone from the companion status — the single steady-state
// signal. connected = ok (green); local-only / busy = warn (amber);
// anything else (disconnected / vault-error / unknown) = err (rose).
function toneFor(status: CompanionStatus): 'ok' | 'warn' | 'err' {
  if (status === 'connected') return 'ok';
  if (status === 'local-only' || status === 'busy') return 'warn';
  return 'err';
}

function companionWord(status: CompanionStatus): string {
  if (status === 'connected') return 'running';
  if (status === 'local-only') return 'local-only';
  if (status === 'busy') return 'busy';
  return 'down';
}

export function ConnectDot({
  companionStatus,
  recallStatus,
  dumpStatus,
  onClearDump,
  onOpenConnectionSettings,
}: ConnectDotProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tone = toneFor(companionStatus);
  const isError = tone === 'err';

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const vaultError = companionStatus === 'vault-error';
  const recallShown = recallStatus !== null && recallStatus !== 'ready';

  return (
    <div ref={rootRef} className="connect-dot">
      <button
        type="button"
        className={'connect-dot-trigger mono tone-' + tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Connection status: companion ${companionWord(companionStatus)}. Open details.`}
        title={`Companion: ${companionStatusLabel(companionStatus)}`}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        data-testid="connect-dot"
      >
        <span className={'connect-dot-glyph tone-' + tone} aria-hidden />
        <span className="connect-dot-word">{companionWord(companionStatus)}</span>
      </button>
      {open ? (
        <div className="connect-dot-popover" role="dialog" aria-label="Connection status">
          <div className="connect-dot-row">
            <span
              className={'connect-dot-glyph ' + (vaultError ? 'tone-err' : 'tone-ok')}
              aria-hidden
            />
            <span className="connect-dot-row-label">Vault</span>
            <span className="connect-dot-row-value mono">
              {vaultError ? 'error' : 'connected'}
            </span>
          </div>
          <div className="connect-dot-row">
            <span className={'connect-dot-glyph tone-' + tone} aria-hidden />
            <span className="connect-dot-row-label">Companion</span>
            <span className="connect-dot-row-value mono">{companionWord(companionStatus)}</span>
          </div>
          {recallShown ? (
            <div className="connect-dot-row">
              <span
                className={
                  'connect-dot-glyph ' +
                  (recallStatus === 'rebuilding' || recallStatus === 'empty'
                    ? 'tone-warn'
                    : 'tone-err')
                }
                aria-hidden
              />
              <span className="connect-dot-row-label">Recall</span>
              <span className="connect-dot-row-value mono">
                {recallStatus === 'rebuilding' ? 'indexing' : recallStatus}
              </span>
            </div>
          ) : null}
          {isError ? (
            <button
              type="button"
              className="connect-dot-fix"
              onClick={() => {
                setOpen(false);
                onOpenConnectionSettings();
              }}
            >
              Fix in Settings →
            </button>
          ) : null}
          {dumpStatus.kind === 'dumped' ? (
            <div className="connect-dot-dump mono" data-testid="dump-result">
              <span className="connect-dot-glyph tone-ok" aria-hidden />
              <span className="connect-dot-dump-label" title={dumpStatus.path}>
                dumped
              </span>
              <button
                type="button"
                className="btn-link connect-dot-dump-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(dumpStatus.path);
                }}
                title="Copy path to clipboard"
              >
                copy
              </button>
              <button
                type="button"
                className="btn-link connect-dot-dump-btn"
                onClick={onClearDump}
                title="Dismiss"
                aria-label="Dismiss dump notice"
              >
                ✕
              </button>
            </div>
          ) : dumpStatus.kind === 'error' ? (
            <div className="connect-dot-dump mono" title={dumpStatus.message} data-testid="dump-result">
              <span className="connect-dot-glyph tone-warn" aria-hidden />
              <span className="connect-dot-dump-label">dump → clipboard fallback</span>
              <button
                type="button"
                className="btn-link connect-dot-dump-btn"
                onClick={onClearDump}
                title="Dismiss"
                aria-label="Dismiss dump notice"
              >
                ✕
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
