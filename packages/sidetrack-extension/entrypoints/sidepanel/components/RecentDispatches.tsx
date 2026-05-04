import { Icons } from './icons';

export type DispatchStatus = 'sent' | 'replied' | 'noted' | 'pending' | 'archived';
export type DispatchMode = 'paste' | 'auto-send';

export interface DispatchEvent {
  readonly bac_id: string;
  readonly sourceTitle: string;
  readonly targetProviderLabel: string;
  // When the matcher in src/companion/dispatchLinking.ts paired this
  // dispatch to a destination thread (the user pasted+sent and we
  // captured the resulting chat), the title goes here. If undefined
  // the dispatch is still "pending" — the chat hasn't been seen yet.
  readonly targetThreadTitle?: string;
  // The dispatch's send mode. Drives the action button: paste-mode
  // shows "Copy" (re-copy + open new chat); auto-send shows
  // "Dispatch" (open + auto-send via the §24.10 orchestrator).
  readonly mode: DispatchMode;
  readonly dispatchKind:
    | 'submit_back'
    | 'dispatch_out'
    | 'research_packet'
    | 'clone_to_chat'
    | 'coding_agent_packet';
  readonly dispatchedAt: string; // relative
  readonly status: DispatchStatus;
}

const KIND_LABEL: Record<DispatchEvent['dispatchKind'], string> = {
  submit_back: 'submit-back',
  dispatch_out: 'dispatch-out',
  research_packet: 'research packet',
  clone_to_chat: 'cloned chat',
  coding_agent_packet: 'coding-agent packet',
};

export interface RecentDispatchesProps {
  readonly dispatches: readonly DispatchEvent[];
  readonly onFocusSource?: (id: string) => void;
  // Click on the target side of a row. For LINKED rows this is "jump
  // to the destination thread"; for UNLINKED rows the host
  // (App.tsx) decides whether to view, copy, or auto-dispatch.
  readonly onOpenTarget?: (id: string) => void;
  // Mode-specific actions for unlinked rows.
  readonly onCopy?: (id: string) => void;
  readonly onDispatch?: (id: string) => void;
  readonly onView?: (id: string) => void;
  // Archive lifecycle. Archived rows hide from the default list; the
  // section header gets a "Show archived" toggle to bring them back.
  readonly onArchive?: (id: string) => void;
  readonly onUnarchive?: (id: string) => void;
  readonly showArchived?: boolean;
  readonly onToggleShowArchived?: () => void;
}

export function RecentDispatches({
  dispatches,
  onFocusSource,
  onOpenTarget,
  onCopy,
  onDispatch,
  onView,
  onArchive,
  onUnarchive,
  showArchived = false,
  onToggleShowArchived,
}: RecentDispatchesProps) {
  const visible = dispatches.filter((d) => showArchived || d.status !== 'archived');
  const archivedCount = dispatches.filter((d) => d.status === 'archived').length;
  const archivedToggle =
    archivedCount > 0 && onToggleShowArchived !== undefined ? (
      <button
        type="button"
        className="btn-link dispatches-archived-toggle mono"
        onClick={onToggleShowArchived}
        title={showArchived ? 'Hide archived dispatches' : 'Show archived dispatches'}
      >
        {showArchived ? `Hide archived (${String(archivedCount)})` : `Show archived (${String(archivedCount)})`}
      </button>
    ) : null;
  if (visible.length === 0) {
    return (
      <div className="dispatches-empty mono">
        <em>
          No dispatches yet. They&apos;ll appear here when you send a packet or submit a review
          back.
        </em>
        {archivedToggle}
      </div>
    );
  }
  return (
    <div className="dispatches-list">
      {archivedToggle}
      {visible.map((dispatch) => {
        const linked = dispatch.targetThreadTitle !== undefined;
        const isArchived = dispatch.status === 'archived';
        return (
          <div
            key={dispatch.bac_id}
            className={'dispatch-row' + (isArchived ? ' is-archived' : '')}
          >
            <button
              type="button"
              className="dispatch-source"
              onClick={() => onFocusSource?.(dispatch.bac_id)}
              title="Jump to the source thread this packet came from"
            >
              <span className="mono dispatch-kind">{KIND_LABEL[dispatch.dispatchKind]}</span>
              <span className="dispatch-source-title">{dispatch.sourceTitle}</span>
            </button>
            <span className="icon-12 dispatch-arrow">{Icons.arrowR}</span>
            <button
              type="button"
              className="dispatch-target"
              onClick={() => onOpenTarget?.(dispatch.bac_id)}
              title={
                linked
                  ? 'Jump to the linked destination chat'
                  : 'View this dispatch (full body, copy, download)'
              }
            >
              <span className="chip">{dispatch.targetProviderLabel}</span>
              <span className="dispatch-target-title">
                {dispatch.targetThreadTitle ??
                  (dispatch.mode === 'auto-send' ? 'send to new thread' : 'open new thread')}
              </span>
            </button>
            {/* Action area: replaces the static status pill with a
                button keyed off mode + linked state.
                  - linked        → "↗ open" (jump to dest thread)
                  - paste, !link  → "Copy"  (re-copy + open new chat)
                  - auto, !link   → "Dispatch" (open + auto-send)
                A small "view" pin sits next to the action so the user
                can always re-open the body modal without committing
                to a side effect. */}
            <span className="dispatch-actions">
              {linked ? (
                <button
                  type="button"
                  className="btn btn-link dispatch-action"
                  onClick={() => onOpenTarget?.(dispatch.bac_id)}
                  title="Jump to the destination chat"
                >
                  ↗ open
                </button>
              ) : dispatch.mode === 'auto-send' ? (
                <button
                  type="button"
                  className="btn btn-link dispatch-action dispatch-action-primary"
                  onClick={() => onDispatch?.(dispatch.bac_id)}
                  title="Open the target chat and auto-send the packet"
                >
                  Dispatch
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-link dispatch-action dispatch-action-primary"
                  onClick={() => onCopy?.(dispatch.bac_id)}
                  title="Re-copy the packet body and open the target chat"
                >
                  Copy
                </button>
              )}
              <button
                type="button"
                className="btn btn-link dispatch-action dispatch-action-secondary"
                onClick={() => onView?.(dispatch.bac_id)}
                title="View the full packet body"
                aria-label="View dispatch body"
              >
                view
              </button>
              {/* Always-visible Dispatch button: re-fires the packet
                  in auto-send mode to a fresh chat. Different from the
                  default unlinked target click (which opens the
                  customize composer pre-loaded from the packet). */}
              {!linked && dispatch.mode !== 'auto-send' ? (
                <button
                  type="button"
                  className="btn btn-link dispatch-action dispatch-action-secondary"
                  onClick={() => onDispatch?.(dispatch.bac_id)}
                  title="Open a new chat and auto-send this packet"
                >
                  dispatch
                </button>
              ) : null}
              {isArchived ? (
                <button
                  type="button"
                  className="btn btn-link dispatch-action dispatch-action-secondary"
                  onClick={() => onUnarchive?.(dispatch.bac_id)}
                  title="Move back to the active list"
                >
                  unarchive
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-link dispatch-action dispatch-action-secondary"
                  onClick={() => onArchive?.(dispatch.bac_id)}
                  title="Hide this dispatch from the default list"
                >
                  archive
                </button>
              )}
            </span>
            <span className="dispatch-time mono">{dispatch.dispatchedAt}</span>
          </div>
        );
      })}
    </div>
  );
}
