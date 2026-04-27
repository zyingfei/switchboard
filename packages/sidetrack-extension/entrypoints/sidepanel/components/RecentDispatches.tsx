import { Icons } from './icons';

export type DispatchStatus = 'sent' | 'replied' | 'noted' | 'pending';

export interface DispatchEvent {
  readonly bac_id: string;
  readonly sourceTitle: string;
  readonly targetProviderLabel: string;
  readonly targetThreadTitle?: string;
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

const STATUS_LABEL: Record<DispatchStatus, string> = {
  sent: 'sent',
  replied: 'replied',
  noted: 'noted',
  pending: 'pending',
};

export interface RecentDispatchesProps {
  readonly dispatches: readonly DispatchEvent[];
  readonly onFocusSource?: (id: string) => void;
  readonly onOpenTarget?: (id: string) => void;
}

export function RecentDispatches({
  dispatches,
  onFocusSource,
  onOpenTarget,
}: RecentDispatchesProps) {
  if (dispatches.length === 0) {
    return (
      <div className="dispatches-empty mono">
        <em>
          No dispatches yet. They'll appear here when you send a packet or submit a review back.
        </em>
      </div>
    );
  }
  return (
    <div className="dispatches-list">
      {dispatches.map((dispatch) => (
        <div key={dispatch.bac_id} className="dispatch-row">
          <button
            type="button"
            className="dispatch-source"
            onClick={() => onFocusSource?.(dispatch.bac_id)}
          >
            <span className="mono dispatch-kind">{KIND_LABEL[dispatch.dispatchKind]}</span>
            <span className="dispatch-source-title">{dispatch.sourceTitle}</span>
          </button>
          <span className="icon-12 dispatch-arrow">{Icons.arrowR}</span>
          <button
            type="button"
            className="dispatch-target"
            onClick={() => onOpenTarget?.(dispatch.bac_id)}
          >
            <span className="chip">{dispatch.targetProviderLabel}</span>
            <span className="dispatch-target-title">
              {dispatch.targetThreadTitle ?? 'new chat'}
            </span>
          </button>
          <span className={'pill pill-' + dispatch.status}>{STATUS_LABEL[dispatch.status]}</span>
          <span className="dispatch-time mono">{dispatch.dispatchedAt}</span>
        </div>
      ))}
    </div>
  );
}
