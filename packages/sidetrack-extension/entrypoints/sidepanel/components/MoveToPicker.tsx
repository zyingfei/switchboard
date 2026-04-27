import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './icons';

export interface WorkstreamOption {
  readonly bac_id: string;
  readonly path: string; // human-readable: "Sidetrack / MVP PRD / Active Work"
}

export interface MoveToPickerProps {
  readonly itemTitle: string;
  readonly currentPath: string;
  readonly workstreams: readonly WorkstreamOption[];
  readonly onClose: () => void;
  readonly onMove: (target: WorkstreamOption | { create: string }) => void;
}

export function MoveToPicker({
  itemTitle,
  currentPath,
  workstreams,
  onClose,
  onMove,
}: MoveToPickerProps) {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const trimmed = filter.trim().toLowerCase();
    if (trimmed === '') {
      return workstreams;
    }
    return workstreams.filter((w) => w.path.toLowerCase().includes(trimmed));
  }, [filter, workstreams]);

  const showCreateHint =
    filter.trim() !== '' &&
    !workstreams.some((w) => w.path.toLowerCase() === filter.trim().toLowerCase());

  return (
    <Modal
      title="Move to…"
      subtitle={`From: ${currentPath} · ${itemTitle}`}
      width={460}
      onClose={onClose}
    >
      <div className="move-search">
        <span className="icon-12">{Icons.search}</span>
        <input
          autoFocus
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          placeholder="Filter workstreams…"
        />
      </div>

      <div className="move-list">
        {filtered.map((workstream) => (
          <button
            key={workstream.bac_id}
            type="button"
            className={'move-item' + (workstream.path === currentPath ? ' current' : '')}
            onClick={() => {
              onMove(workstream);
            }}
            disabled={workstream.path === currentPath}
          >
            <span className="icon-12">{Icons.folder}</span>
            <span className="move-path">{workstream.path}</span>
            {workstream.path === currentPath ? (
              <span className="mono move-current">current</span>
            ) : null}
          </button>
        ))}
        {filtered.length === 0 ? (
          <div className="move-empty mono">No matching workstreams.</div>
        ) : null}
      </div>

      {showCreateHint ? (
        <button
          type="button"
          className="move-create"
          onClick={() => {
            onMove({ create: filter.trim() });
          }}
        >
          <span className="icon-12">{Icons.plus}</span>
          Create new: <strong>{filter.trim()}</strong>
        </button>
      ) : null}

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
