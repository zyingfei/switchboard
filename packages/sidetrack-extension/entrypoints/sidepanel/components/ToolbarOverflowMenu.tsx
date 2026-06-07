import { useEffect, useRef, useState } from 'react';
import { Icons } from './icons';

// Toolbar overflow ("⋯") menu. Collapses the diagnostic actions —
// Capture health, Dump panel state, Design preview — that used to sit
// as standalone icons in the top bar. Keeping them one click away
// declutters the steady-state toolbar without hiding them behind a
// build flag. Dismisses on outside-click, Escape, or picking an item.

export type DumpStatusKind = 'idle' | 'dumping' | 'dumped' | 'error';

export interface ToolbarOverflowMenuProps {
  readonly onOpenHealth: () => void;
  readonly onDumpState: () => void;
  readonly onOpenDesignPreview: () => void;
  // Surfaced on the trigger (pulses while dumping) and the Dump row so
  // the user gets the same feedback the standalone button used to give.
  readonly dumpStatus: DumpStatusKind;
}

export function ToolbarOverflowMenu({
  onOpenHealth,
  onDumpState,
  onOpenDesignPreview,
  dumpStatus,
}: ToolbarOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  const pick = (run: () => void) => (): void => {
    run();
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="toolbar-overflow">
      <button
        className={
          'icon-btn' +
          (open ? ' on' : '') +
          (dumpStatus === 'dumping' ? ' pulsing' : '') +
          (dumpStatus === 'error' ? ' warn' : '')
        }
        title="More — diagnostics"
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More tools"
        data-testid="toolbar-overflow"
      >
        <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.more}</span>
      </button>
      {open ? (
        <div className="toolbar-overflow-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="toolbar-overflow-item"
            onClick={pick(onOpenHealth)}
          >
            <span className="toolbar-overflow-item-icon">{Icons.activity}</span>
            <span className="toolbar-overflow-item-label">Capture health</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={
              'toolbar-overflow-item' + (dumpStatus === 'dumped' ? ' toolbar-overflow-item-on' : '')
            }
            onClick={pick(onDumpState)}
            data-testid="dump-panel-state"
          >
            <span className="toolbar-overflow-item-icon">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </span>
            <span className="toolbar-overflow-item-label">
              Dump panel state
              {dumpStatus === 'dumped' ? ' ✓' : dumpStatus === 'dumping' ? '…' : ''}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="toolbar-overflow-item"
            onClick={pick(onOpenDesignPreview)}
          >
            <span className="toolbar-overflow-item-icon">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="13" cy="6" r="2" />
                <circle cx="6" cy="13" r="2" />
                <circle cx="13" cy="20" r="2" />
                <circle cx="20" cy="13" r="2" />
                <line x1="11.6" y1="7.4" x2="7.4" y2="11.6" />
                <line x1="14.4" y1="7.4" x2="18.6" y2="11.6" />
                <line x1="11.6" y1="18.6" x2="7.4" y2="14.4" />
                <line x1="14.4" y1="18.6" x2="18.6" y2="14.4" />
              </svg>
            </span>
            <span className="toolbar-overflow-item-label">Design preview</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
