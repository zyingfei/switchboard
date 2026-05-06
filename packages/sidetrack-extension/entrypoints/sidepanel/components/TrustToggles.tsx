import { Icons } from './icons';

// Per-workstream MCP write-tool trust toggles. Default-allow —
// fresh workstreams have no record on disk so every tool is on
// until the user toggles one off (writing a deny-list record via
// PUT). Once a record exists, its allow-list is honored as-is.
//
// Backed by GET/PUT /v1/workstreams/{id}/trust. The parent fetches
// on detail-panel open and writes back on each toggle.

export type TrustTool =
  | 'sidetrack.threads.move'
  | 'sidetrack.queue.create'
  | 'sidetrack.workstreams.bump'
  | 'sidetrack.threads.archive'
  | 'sidetrack.threads.unarchive';

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
          <div className="t1">MCP write tools — default allow</div>
          <div className="t2">
            Toggle one off to deny just that tool with <code>NOT_TRUSTED</code>.
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
