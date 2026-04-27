import { Modal } from './Modal';

export type RestoreStrategy =
  | 'focus_open'
  | 'restore_session'
  | 'reopen_url'
  | 'recreate'
  | 'unknown';

const noopHandler = () => {
  // Placeholder when an optional restore handler is not provided.
};

export interface TabSnapshot {
  readonly title: string;
  readonly url: string;
  readonly provider?: string;
  readonly favIconUrl?: string;
  readonly capturedAt: string;
  readonly lastActiveAt: string;
  readonly restoreStrategy: RestoreStrategy;
}

export interface TabRecoveryProps {
  readonly snapshot: TabSnapshot;
  readonly onClose: () => void;
  readonly onFocusOpen?: () => void;
  readonly onRestoreSession?: () => void;
  readonly onReopenUrl: () => void;
}

const STRATEGY_LABEL: Record<RestoreStrategy, string> = {
  focus_open: 'Focus open tab',
  restore_session: 'Restore from session history',
  reopen_url: 'Reopen URL',
  recreate: 'Recreate from snapshot',
  unknown: 'Unknown',
};

export function TabRecovery({
  snapshot,
  onClose,
  onFocusOpen,
  onRestoreSession,
  onReopenUrl,
}: TabRecoveryProps) {
  const strategies: {
    key: RestoreStrategy;
    available: boolean;
    primary: boolean;
    handler: () => void;
  }[] = [
    {
      key: 'focus_open',
      available: snapshot.restoreStrategy === 'focus_open' && onFocusOpen !== undefined,
      primary: snapshot.restoreStrategy === 'focus_open',
      handler: onFocusOpen ?? noopHandler,
    },
    {
      key: 'restore_session',
      available: onRestoreSession !== undefined,
      primary: snapshot.restoreStrategy === 'restore_session',
      handler: onRestoreSession ?? noopHandler,
    },
    {
      key: 'reopen_url',
      available: true,
      primary: snapshot.restoreStrategy === 'reopen_url',
      handler: onReopenUrl,
    },
  ];

  const primary =
    strategies.find((s) => s.primary && s.available) ?? strategies.find((s) => s.available);

  return (
    <Modal title="Reopen this tab?" subtitle={snapshot.url} width={460} onClose={onClose}>
      <div className="recovery-snapshot">
        <div className="recovery-title ai-italic">{snapshot.title}</div>
        <div className="recovery-meta mono">
          {snapshot.provider ? <span className="chip">{snapshot.provider}</span> : null}
          <span>captured {snapshot.capturedAt}</span>
          <span>·</span>
          <span>last active {snapshot.lastActiveAt}</span>
        </div>
      </div>

      <div className="recovery-strategies">
        {strategies.map((s) => (
          <button
            key={s.key}
            type="button"
            className={
              'btn ' + (s.primary ? 'btn-primary' : 'btn-ghost') + (!s.available ? ' disabled' : '')
            }
            disabled={!s.available}
            onClick={s.handler}
          >
            {STRATEGY_LABEL[s.key]}
          </button>
        ))}
      </div>

      <div className="recovery-status mono">
        Will run: <strong>{primary ? STRATEGY_LABEL[primary.key] : 'unknown'}</strong>
      </div>
    </Modal>
  );
}
