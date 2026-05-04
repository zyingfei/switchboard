import { Icons } from './icons';

// Per-workstream MCP write-tool trust toggles. Default-deny — coding
// agents calling write tools (move/queue/bump/archive/unarchive) on
// this workstream get NOT_TRUSTED unless explicitly allowed.
//
// Backed by GET/PUT /v1/workstreams/{id}/trust (PR #78 Track W). When
// PR #78 lands, the parent fetches the current Trust record on mount
// and writes back on each toggle.

export type TrustTool =
  | 'bac.move_item'
  | 'bac.queue_item'
  | 'bac.bump_workstream'
  | 'bac.archive_thread'
  | 'bac.unarchive_thread';

export interface TrustEntry {
  readonly tool: TrustTool;
  readonly humanLabel: string;
  readonly description: string;
  readonly allowed: boolean;
}

interface TrustTogglesProps {
  readonly entries: readonly TrustEntry[];
  readonly onToggle: (tool: TrustTool, next: boolean) => void;
}

export function TrustToggles({ entries, onToggle }: TrustTogglesProps) {
  return (
    <div className="trust-toggles">
      <div className="trust-head">
        <span className="lock">{Icons.lock}</span>
        <div>
          <div className="t1">MCP write tools — default deny</div>
          <div className="t2">
            Tools not on this list refuse with <code>NOT_TRUSTED</code>.
          </div>
        </div>
      </div>
      {entries.map((e) => (
        <button
          key={e.tool}
          type="button"
          className={'trust-row' + (e.allowed ? ' on' : '')}
          onClick={() => {
            onToggle(e.tool, !e.allowed);
          }}
          aria-pressed={e.allowed}
        >
          <span className="cb" />
          <div className="body">
            <div className="r1">
              <code>{e.humanLabel}</code>
            </div>
            <div className="r2">{e.description}</div>
          </div>
          <span className="state">{e.allowed ? 'allow' : 'deny'}</span>
        </button>
      ))}
    </div>
  );
}
