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
  // No-capture rule actions for the current tab. When the current tab
  // has no capturable http(s) URL these are omitted (undefined) and the
  // rows don't render. A short label (the eTLD+1) shown inline.
  readonly currentSiteLabel?: string;
  readonly onBlockCurrentSite?: () => void;
  readonly onBlockSimilarSites?: () => void;
  // Secondary capture tools, relocated out of the top toolbar (R1.1) to
  // keep the steady-state chrome lean. Testids/labels are preserved so
  // §13 steps + e2e stay reachable; each quiesces (disabled) under paused.
  readonly screenShareMode?: boolean;
  readonly onToggleScreenShare?: () => void;
  readonly onFindActiveTab?: () => void;
  readonly onAttachCoding?: () => void;
  // When set, the secondary capture tools render disabled (capture paused).
  readonly captureTools?: 'live' | 'quiesced';
}

export function ToolbarOverflowMenu({
  onOpenHealth,
  onDumpState,
  onOpenDesignPreview,
  dumpStatus,
  currentSiteLabel,
  onBlockCurrentSite,
  onBlockSimilarSites,
  screenShareMode = false,
  onToggleScreenShare,
  onFindActiveTab,
  onAttachCoding,
  captureTools = 'live',
}: ToolbarOverflowMenuProps) {
  const toolsDisabled = captureTools === 'quiesced';
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
          {onBlockCurrentSite !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className="toolbar-overflow-item"
              onClick={pick(onBlockCurrentSite)}
              data-testid="block-current-site"
              title={
                currentSiteLabel === undefined
                  ? "Don't capture this site"
                  : `Don't capture ${currentSiteLabel}`
              }
            >
              <span className="toolbar-overflow-item-icon">{Icons.eyeOff ?? Icons.activity}</span>
              <span className="toolbar-overflow-item-label">
                Don&rsquo;t capture this site
                {currentSiteLabel === undefined ? '' : ` (${currentSiteLabel})`}
              </span>
            </button>
          ) : null}
          {onBlockSimilarSites !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className="toolbar-overflow-item"
              onClick={pick(onBlockSimilarSites)}
              data-testid="block-similar-sites"
              title="Don't capture similar sites (account / billing / login pages)"
            >
              <span className="toolbar-overflow-item-icon">{Icons.eyeOff ?? Icons.activity}</span>
              <span className="toolbar-overflow-item-label">Don&rsquo;t capture similar sites</span>
            </button>
          ) : null}
          {onToggleScreenShare !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className={
                'toolbar-overflow-item' + (screenShareMode ? ' toolbar-overflow-item-on' : '')
              }
              onClick={pick(onToggleScreenShare)}
              disabled={toolsDisabled}
              aria-pressed={screenShareMode}
              aria-label="Toggle screenshare mode"
              title="Screenshare mode — mask sensitive workstreams"
            >
              <span className="toolbar-overflow-item-icon">{Icons.cast}</span>
              <span className="toolbar-overflow-item-label">
                Screenshare mask{screenShareMode ? ' ✓' : ''}
              </span>
            </button>
          ) : null}
          {onFindActiveTab !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className="toolbar-overflow-item"
              onClick={pick(onFindActiveTab)}
              disabled={toolsDisabled}
              aria-label="Find active tab in side panel"
              title="Find this tab in the side panel — scrolls + flashes the matching thread row"
            >
              <span className="toolbar-overflow-item-icon">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                  <line x1="12" y1="2" x2="12" y2="5.5" />
                  <line x1="12" y1="18.5" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="5.5" y2="12" />
                  <line x1="18.5" y1="12" x2="22" y2="12" />
                </svg>
              </span>
              <span className="toolbar-overflow-item-label">Find active tab</span>
            </button>
          ) : null}
          {onAttachCoding !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className="toolbar-overflow-item"
              onClick={pick(onAttachCoding)}
              disabled={toolsDisabled}
              aria-label="Attach coding session"
              title="Attach a coding-agent session (companion required)"
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
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <polyline points="6 10 9 13 6 16" />
                  <line x1="13" y1="16" x2="18" y2="16" />
                </svg>
              </span>
              <span className="toolbar-overflow-item-label">Attach coding session</span>
            </button>
          ) : null}
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
