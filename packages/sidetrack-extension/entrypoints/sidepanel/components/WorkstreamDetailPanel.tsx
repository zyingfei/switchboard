import { useEffect, useMemo, useRef, useState } from 'react';

import { Icons } from './icons';
import type { LinkedNote } from './LinkedNotes';
import { LinkedNotes } from './LinkedNotes';
import type { TrustEntry, TrustTool } from './TrustToggles';
import { TrustToggles } from './TrustToggles';

// Workstream detail full-panel surface — combines linked notes (PR #76
// Track C) and per-workstream MCP write-tool trust (PR #78 Track W)
// into one focused view. Reachable from the workboard via a header
// icon or workstream-row affordance (caller wires).

export interface WorkstreamDetailNode {
  readonly bac_id: string;
  readonly title: string;
  readonly parentId?: string;
}

interface WorkstreamDetailPanelProps {
  readonly workstreamLabel: string;
  // The workstream this panel is editing. May be undefined when the
  // caller hasn't wired the new edit affordances yet — in that case
  // the rename / move surfaces stay hidden so the panel still works
  // in read-only mode.
  readonly workstream?: WorkstreamDetailNode;
  // The full set of workstreams (for the "Move to…" parent picker).
  // Filtered locally to exclude self + descendants.
  readonly workstreams?: readonly WorkstreamDetailNode[];
  readonly linkedNotes: readonly LinkedNote[];
  readonly trustEntries: readonly TrustEntry[];
  readonly onClose: () => void;
  readonly onAddLink?: () => void;
  readonly onTrustChange: (tool: TrustTool, next: boolean) => void;
  readonly onRename?: (nextTitle: string) => void;
  // null = move to top-level (clear parent). string = re-parent under
  // that workstream's bac_id.
  readonly onMove?: (parentId: string | null) => void;
  // Delete is destructive: companion refuses if the workstream still
  // has child workstreams (the side panel surfaces that as an error
  // pill, not a silent failure). Threads pointing at this workstream
  // are detached back to Inbox by the writer.
  readonly onDelete?: () => Promise<void> | void;
  // Number of threads currently pointing at this workstream — shown
  // in the confirm copy so the user knows what'll be detached.
  readonly threadCount?: number;
}

const collectDescendantIds = (
  rootId: string,
  workstreams: readonly WorkstreamDetailNode[],
): Set<string> => {
  const out = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const w of workstreams) {
      if (w.parentId !== undefined && out.has(w.parentId) && !out.has(w.bac_id)) {
        out.add(w.bac_id);
        added = true;
      }
    }
  }
  return out;
};

export function WorkstreamDetailPanel({
  workstreamLabel,
  workstream,
  workstreams = [],
  linkedNotes,
  trustEntries,
  onClose,
  onAddLink,
  onTrustChange,
  onRename,
  onMove,
  onDelete,
  threadCount,
}: WorkstreamDetailPanelProps) {
  const renameEnabled = onRename !== undefined && workstream !== undefined;
  const moveEnabled = onMove !== undefined && workstream !== undefined;
  const deleteEnabled = onDelete !== undefined && workstream !== undefined;
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(workstreamLabel);
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const childCount = useMemo(() => {
    if (workstream === undefined) return 0;
    return workstreams.filter((w) => w.parentId === workstream.bac_id).length;
  }, [workstream, workstreams]);

  useEffect(() => {
    setDraftTitle(workstreamLabel);
  }, [workstreamLabel]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  const parent = useMemo(() => {
    if (workstream?.parentId === undefined) return undefined;
    return workstreams.find((w) => w.bac_id === workstream.parentId);
  }, [workstream, workstreams]);

  // Self + every descendant is an invalid parent (would form a cycle).
  // Current parent is filtered out of the list since picking it is
  // a no-op; surfaced as a hint label in the picker header instead.
  const moveCandidates = useMemo(() => {
    if (workstream === undefined) return [] as readonly WorkstreamDetailNode[];
    const banned = collectDescendantIds(workstream.bac_id, workstreams);
    return workstreams.filter(
      (w) => !banned.has(w.bac_id) && w.bac_id !== workstream.parentId,
    );
  }, [workstream, workstreams]);

  const commitRename = (): void => {
    const next = draftTitle.trim();
    if (next.length === 0 || next === workstreamLabel || !renameEnabled) {
      setRenaming(false);
      setDraftTitle(workstreamLabel);
      return;
    }
    onRename(next);
    setRenaming(false);
  };

  return (
    <div className="detail-view" role="dialog" aria-label={`Workstream — ${workstreamLabel}`}>
      <div className="detail-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.back}</span>
        </button>
        {renaming ? (
          <input
            ref={renameInputRef}
            type="text"
            className="ws-detail-rename-input"
            value={draftTitle}
            onChange={(e) => {
              setDraftTitle(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitRename();
              } else if (e.key === 'Escape') {
                setRenaming(false);
                setDraftTitle(workstreamLabel);
              }
            }}
            onBlur={commitRename}
            aria-label="Rename workstream"
          />
        ) : (
          <button
            type="button"
            className={'ws-detail-title' + (renameEnabled ? ' editable' : '')}
            onClick={() => {
              if (renameEnabled) setRenaming(true);
            }}
            disabled={!renameEnabled}
            title={renameEnabled ? 'Rename workstream' : undefined}
          >
            <span className="title">{workstreamLabel}</span>
            {renameEnabled ? <span className="ws-detail-rename-hint" aria-hidden>✎</span> : null}
          </button>
        )}
        <span className="muted">workstream</span>
      </div>

      {moveEnabled ? (
        <div className="detail-sec">
          <div className="detail-sec-head">Hierarchy</div>
          <div className="ws-detail-hierarchy">
            <span className="ws-detail-hierarchy-label">
              {parent === undefined ? (
                <em className="subtle">Top-level group</em>
              ) : (
                <>
                  <span className="subtle">Sub-group of</span>{' '}
                  <span className="mono">{parent.title}</span>
                </>
              )}
            </span>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setMovePickerOpen(true);
              }}
            >
              Move to…
            </button>
          </div>
        </div>
      ) : null}

      <div className="detail-sec">
        <div className="detail-sec-head">
          Linked notes · from your vault ({linkedNotes.length})
        </div>
        <LinkedNotes notes={linkedNotes} onAddLink={onAddLink} />
      </div>

      <div className="detail-sec">
        <div className="detail-sec-head">MCP write tools · trust</div>
        <TrustToggles entries={trustEntries} onToggle={onTrustChange} />
      </div>

      {deleteEnabled ? (
        <div className="detail-sec ws-detail-danger">
          <div className="detail-sec-head">Danger zone</div>
          <div className="ws-detail-hierarchy">
            <span className="ws-detail-hierarchy-label">
              {childCount > 0 ? (
                <em className="subtle">
                  Detach {String(childCount)} child group
                  {childCount === 1 ? '' : 's'} before deleting.
                </em>
              ) : (
                <em className="subtle">
                  Delete this group; threads inside fall back to Inbox.
                </em>
              )}
            </span>
            <button
              type="button"
              className="btn-link ws-detail-delete-trigger"
              disabled={childCount > 0}
              onClick={() => {
                setDeleteError(null);
                setDeleteConfirmOpen(true);
              }}
            >
              Delete group
            </button>
          </div>
        </div>
      ) : null}

      {deleteConfirmOpen && deleteEnabled && workstream !== undefined ? (
        <div
          className="ws-picker-backdrop"
          onClick={() => {
            if (!deleting) setDeleteConfirmOpen(false);
          }}
          role="presentation"
        >
          <div
            className="ws-picker ws-detail-delete-confirm"
            onClick={(e) => {
              e.stopPropagation();
            }}
            role="alertdialog"
            aria-label="Confirm delete workstream"
          >
            <div className="ws-detail-move-head">
              Delete <span className="mono">{workstream.title}</span>?
            </div>
            <div className="ws-detail-delete-body">
              <p>This is permanent — there's no undo.</p>
              <ul className="ws-detail-delete-impact mono">
                <li>Group record + .md sidecar are removed.</li>
                <li>
                  {threadCount === undefined || threadCount === 0
                    ? 'No threads currently point at this group.'
                    : `${String(threadCount)} thread${
                        threadCount === 1 ? '' : 's'
                      } will be detached back to Inbox.`}
                </li>
              </ul>
              {deleteError !== null ? (
                <div className="ws-detail-delete-error mono" role="alert">
                  {deleteError}
                </div>
              ) : null}
            </div>
            <div className="ws-detail-delete-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={deleting}
                onClick={() => {
                  setDeleteConfirmOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary ws-detail-delete-confirm-btn"
                disabled={deleting}
                onClick={() => {
                  setDeleting(true);
                  void Promise.resolve(onDelete?.())
                    .then(() => {
                      setDeleteConfirmOpen(false);
                      onClose();
                    })
                    .catch((error: unknown) => {
                      setDeleteError(
                        error instanceof Error ? error.message : 'Delete failed.',
                      );
                    })
                    .finally(() => {
                      setDeleting(false);
                    });
                }}
              >
                {deleting ? 'Deleting…' : 'Delete group'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {movePickerOpen && moveEnabled && workstream !== undefined ? (
        <div
          className="ws-picker-backdrop"
          onClick={() => {
            setMovePickerOpen(false);
          }}
          role="presentation"
        >
          <div
            className="ws-picker"
            onClick={(e) => {
              e.stopPropagation();
            }}
            role="menu"
          >
            <div className="ws-detail-move-head">
              Move <span className="mono">{workstream.title}</span> under…
            </div>
            <div className="ws-picker-list">
              <button
                type="button"
                className={
                  'ws-picker-row' + (workstream.parentId === undefined ? ' on' : '')
                }
                onClick={() => {
                  if (workstream.parentId !== undefined) {
                    onMove(null);
                  }
                  setMovePickerOpen(false);
                }}
              >
                <span className="ws-picker-name">
                  Top-level <em className="subtle">· no parent</em>
                </span>
                <span className="mono subtle">{workstream.parentId === undefined ? '✓' : ''}</span>
              </button>
              {moveCandidates.map((w) => (
                <button
                  type="button"
                  key={w.bac_id}
                  className="ws-picker-row"
                  onClick={() => {
                    onMove(w.bac_id);
                    setMovePickerOpen(false);
                  }}
                >
                  <span className="ws-picker-name">
                    {w.title}
                    {w.parentId !== undefined ? <em className="subtle"> · sub</em> : null}
                  </span>
                  <span className="mono subtle" aria-hidden></span>
                </button>
              ))}
              {moveCandidates.length === 0 ? (
                <div className="ws-detail-move-empty subtle">
                  No other workstreams available to move under.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
