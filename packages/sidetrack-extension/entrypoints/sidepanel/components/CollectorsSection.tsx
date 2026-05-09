import { useState, type CSSProperties } from 'react';

import { formatRelative } from '../../../src/util/time';

type CollectorLoadStatus = 'loaded' | 'load-failed';
type CollectorStability = 'alpha' | 'beta' | 'stable' | 'deprecated';
type CapabilityGateState = 'granted' | 'revoked' | 'pending';

export interface CollectorStatus {
  readonly collector_id: string;
  readonly name: string;
  readonly version: string;
  readonly manifest_schema: number;
  readonly status: CollectorLoadStatus;
  readonly rejected_reason?: string;
  readonly emits: ReadonlyArray<{
    readonly event_type: string;
    readonly payload_version: number;
    readonly stability: CollectorStability;
  }>;
  readonly capabilities: {
    readonly reads_paths: readonly string[];
    readonly reads_env: readonly string[];
    readonly reads_network: boolean;
    readonly default_enabled: boolean;
  };
  readonly capability_gates: Record<string, CapabilityGateState>;
  readonly quarantine_count: number;
  readonly last_promoted_at: string | null;
}

export interface CollectorsSectionProps {
  readonly collectors: readonly CollectorStatus[];
  readonly onReplay: (collectorId: string) => Promise<void>;
}

const formatList = (items: readonly string[]): string =>
  items.length > 0 ? items.join(', ') : 'none';

const statusBadgeStyle = (status: CollectorLoadStatus): CSSProperties => ({
  border: '1px solid ' + (status === 'loaded' ? 'var(--green-tint)' : 'var(--signal, #c0392b)'),
  background: status === 'loaded' ? 'var(--green-bg)' : 'var(--danger-bg, #fff1f0)',
  color: status === 'loaded' ? 'var(--green)' : 'var(--signal, #c0392b)',
  borderRadius: 999,
  padding: '2px 7px',
  fontSize: 10,
  letterSpacing: '0.04em',
});

const lastPromotedLabel = (lastPromotedAt: string | null): string =>
  lastPromotedAt === null ? 'never' : formatRelative(lastPromotedAt);

export function CollectorsSection({ collectors, onReplay }: CollectorsSectionProps) {
  const [replayingCollectorId, setReplayingCollectorId] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const handleReplay = async (collectorId: string): Promise<void> => {
    setReplayingCollectorId(collectorId);
    setReplayError(null);
    try {
      await onReplay(collectorId);
    } catch (error) {
      setReplayError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplayingCollectorId(null);
    }
  };

  return (
    <div className="settings-sec-v2" id="sec-collectors">
      <div className="sec-h">Collectors</div>
      {collectors.length === 0 ? (
        <p className="settings-hint mono">
          No collectors loaded yet. See docs/adding-a-collector.md to install one.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {collectors.map((collector) => {
            const gates = Object.entries(collector.capability_gates);
            return (
              <div key={collector.collector_id} className="port-card">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    justifyContent: 'space-between',
                  }}
                >
                  <div className="t1">{collector.name}</div>
                  <span className="mono" style={statusBadgeStyle(collector.status)}>
                    {collector.status}
                  </span>
                </div>
                <div className="t2">
                  <code>{collector.collector_id}</code>@{collector.version} {' · '}manifest_schema{' '}
                  {String(collector.manifest_schema)}
                </div>
                {collector.status === 'load-failed' ? (
                  <div
                    className="mono"
                    style={{
                      border: '1px solid var(--signal, #c0392b)',
                      background: 'var(--danger-bg, #fff1f0)',
                      color: 'var(--signal, #c0392b)',
                      borderRadius: 4,
                      padding: '6px 8px',
                      marginBottom: 8,
                      fontSize: 10.5,
                    }}
                  >
                    Rejected: {collector.rejected_reason ?? 'unknown reason'}
                  </div>
                ) : null}
                <div className="t2">
                  Emits:{' '}
                  {collector.emits.length === 0 ? (
                    'none'
                  ) : (
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                      {collector.emits.map((event) => (
                        <span
                          key={`${event.event_type}:${String(event.payload_version)}`}
                          className="chip"
                        >
                          {event.event_type}@v{String(event.payload_version)} {' · '}
                          {event.stability}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="t2">
                  Reads paths: {formatList(collector.capabilities.reads_paths)}
                  <br />
                  Reads env: {formatList(collector.capabilities.reads_env)}
                  <br />
                  Reads network: {collector.capabilities.reads_network ? 'yes' : 'no'}
                </div>
                <div className="t2">
                  Capability gates:{' '}
                  {gates.length === 0 ? (
                    'none'
                  ) : (
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                      {gates.map(([capability, state]) => (
                        <span key={capability} className="chip">
                          {capability}: {state}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="settings-cta-row" style={{ marginTop: 8, alignItems: 'center' }}>
                  {collector.quarantine_count > 0 ? (
                    <>
                      <span className="mono">{String(collector.quarantine_count)} quarantined</span>
                      <button
                        type="button"
                        className="settings-button"
                        disabled={replayingCollectorId === collector.collector_id}
                        onClick={() => {
                          void handleReplay(collector.collector_id);
                        }}
                      >
                        {replayingCollectorId === collector.collector_id
                          ? 'Replaying...'
                          : 'Replay'}
                      </button>
                    </>
                  ) : (
                    <span className="mono">0 quarantined</span>
                  )}
                  <span className="mono" style={{ marginLeft: 'auto', color: 'var(--ink-3)' }}>
                    Last promoted: {lastPromotedLabel(collector.last_promoted_at)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {replayError !== null ? (
        <div className="settings-hint mono">Replay failed: {replayError}</div>
      ) : null}
    </div>
  );
}
