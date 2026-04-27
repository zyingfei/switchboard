import { Icons } from './icons';

export type SystemState =
  | 'companion_disconnected'
  | 'vault_unreachable'
  | 'provider_broken'
  | 'screen_share_active'
  | 'injection_detected';

export interface SystemBannerProps {
  readonly state: SystemState;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

const STATE_CONFIG: Record<
  SystemState,
  { tone: 'red' | 'amber' | 'yellow' | 'signal'; icon: keyof typeof Icons; titleFn: (detail?: string) => string }
> = {
  companion_disconnected: {
    tone: 'red',
    icon: 'alert',
    titleFn: (detail) => 'Companion: disconnected' + (detail !== undefined ? ` · ${detail}` : ''),
  },
  vault_unreachable: {
    tone: 'amber',
    icon: 'alert',
    titleFn: (detail) => 'Vault: error' + (detail !== undefined ? ` — ${detail}` : ''),
  },
  provider_broken: {
    tone: 'yellow',
    icon: 'alert',
    titleFn: (detail) =>
      detail !== undefined ? `Provider extractor: ${detail}` : 'Provider extractor: clipboard fallback active',
  },
  screen_share_active: {
    tone: 'signal',
    icon: 'cast',
    titleFn: () => 'Screen-share active — content masked',
  },
  injection_detected: {
    tone: 'signal',
    icon: 'alert',
    titleFn: () => 'Captured-page content looks like a prompt-injection attempt',
  },
};

export function SystemBanner({ state, detail, action }: SystemBannerProps) {
  const config = STATE_CONFIG[state];
  return (
    <div className={'sys-banner sys-' + config.tone} role="status">
      <span className="icon-12">{Icons[config.icon]}</span>
      <span className="sys-title">{config.titleFn(detail)}</span>
      {action ? (
        <button type="button" className="sys-action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export interface SystemBannersStackProps {
  readonly companionStatus?: 'running' | 'slow' | 'down';
  readonly vaultStatus?: 'connected' | 'unreachable';
  readonly providerHealth?: 'ok' | 'degraded';
  readonly providerHealthDetail?: string;
  readonly screenShareActive?: boolean;
  readonly injectionDetected?: boolean;
  readonly queuedCount?: number;
  readonly onRetryCompanion?: () => void;
  readonly onRePickVault?: () => void;
  readonly onQueueDiagnostic?: () => void;
}

export function SystemBannersStack({
  companionStatus = 'running',
  vaultStatus = 'connected',
  providerHealth = 'ok',
  providerHealthDetail,
  screenShareActive = false,
  injectionDetected = false,
  queuedCount,
  onRetryCompanion,
  onRePickVault,
  onQueueDiagnostic,
}: SystemBannersStackProps) {
  const banners = [];
  if (companionStatus === 'down') {
    banners.push(
      <SystemBanner
        key="companion"
        state="companion_disconnected"
        detail={queuedCount !== undefined ? `${String(queuedCount)} items queued` : undefined}
        action={onRetryCompanion ? { label: 'Retry', onClick: onRetryCompanion } : undefined}
      />,
    );
  }
  if (vaultStatus === 'unreachable') {
    banners.push(
      <SystemBanner
        key="vault"
        state="vault_unreachable"
        detail="re-pick folder?"
        action={onRePickVault ? { label: 'Re-pick', onClick: onRePickVault } : undefined}
      />,
    );
  }
  if (providerHealth === 'degraded') {
    banners.push(
      <SystemBanner
        key="provider"
        state="provider_broken"
        detail={providerHealthDetail}
        action={onQueueDiagnostic ? { label: 'Queue diagnostic', onClick: onQueueDiagnostic } : undefined}
      />,
    );
  }
  if (screenShareActive) {
    banners.push(<SystemBanner key="ss" state="screen_share_active" />);
  }
  if (injectionDetected) {
    banners.push(<SystemBanner key="inj" state="injection_detected" />);
  }
  return <>{banners}</>;
}
