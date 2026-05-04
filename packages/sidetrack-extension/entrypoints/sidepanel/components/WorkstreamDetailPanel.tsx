import { Icons } from './icons';
import type { LinkedNote } from './LinkedNotes';
import { LinkedNotes } from './LinkedNotes';
import type { TrustEntry, TrustTool } from './TrustToggles';
import { TrustToggles } from './TrustToggles';

// Workstream detail full-panel surface — combines linked notes (PR #76
// Track C) and per-workstream MCP write-tool trust (PR #78 Track W)
// into one focused view. Reachable from the workboard via a header
// icon or workstream-row affordance (caller wires).

interface WorkstreamDetailPanelProps {
  readonly workstreamLabel: string;
  readonly linkedNotes: readonly LinkedNote[];
  readonly trustEntries: readonly TrustEntry[];
  readonly onClose: () => void;
  readonly onAddLink?: () => void;
  readonly onTrustChange: (tool: TrustTool, next: boolean) => void;
}

export function WorkstreamDetailPanel({
  workstreamLabel,
  linkedNotes,
  trustEntries,
  onClose,
  onAddLink,
  onTrustChange,
}: WorkstreamDetailPanelProps) {
  return (
    <div className="detail-view" role="dialog" aria-label={`Workstream — ${workstreamLabel}`}>
      <div className="detail-head">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.back}</span>
        </button>
        <span className="title">{workstreamLabel}</span>
        <span className="muted">workstream</span>
      </div>

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
    </div>
  );
}
