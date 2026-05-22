import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionsSnapshot } from './types.js';

export type IncrementalGraphDisposition = 'row-local' | 'full-reducer';

export interface IncrementalGraphEventClass {
  readonly eventType: string;
  readonly disposition: IncrementalGraphDisposition;
  readonly reason: string;
}

export interface IncrementalGraphDrainPlan {
  readonly initialized: boolean;
  readonly pendingEventCount: number;
  readonly rowLocalEventCount: number;
  readonly fullReducerEventCount: number;
  readonly canUseRowLocalOnly: boolean;
  readonly eventTypes: readonly IncrementalGraphEventClass[];
}

const ROW_LOCAL_EVENT_TYPES = new Set<string>([
  'browser.timeline.observed',
  'navigation.committed',
  'threads.upserted',
  'workstreams.upserted',
  'tabsession.attribution.inferred',
  'url.attribution.inferred',
  'user.organized.item',
]);

const rowLocalReason = (eventType: string): string => {
  if (eventType === 'browser.timeline.observed' || eventType === 'navigation.committed') {
    return 'timeline/url/tab-session rows';
  }
  if (eventType === 'threads.upserted') return 'thread node row';
  if (eventType === 'workstreams.upserted') return 'workstream node row';
  if (eventType === 'tabsession.attribution.inferred') return 'tab-session attribution edge rows';
  if (eventType === 'url.attribution.inferred') return 'url attribution edge rows';
  if (eventType === 'user.organized.item') return 'user assertion overlay rows';
  return 'row-local';
};

export class IncrementalConnectionsGraphView {
  #snapshotRevision: string | null = null;
  #pending: IncrementalGraphEventClass[] = [];

  seed(snapshot: ConnectionsSnapshot): void {
    this.#snapshotRevision = snapshot.snapshotRevision ?? snapshot.updatedAt;
    this.#pending = [];
  }

  reset(): void {
    this.#snapshotRevision = null;
    this.#pending = [];
  }

  fold(event: AcceptedEvent): void {
    if (ROW_LOCAL_EVENT_TYPES.has(event.type)) {
      this.#pending.push({
        eventType: event.type,
        disposition: 'row-local',
        reason: rowLocalReason(event.type),
      });
      return;
    }
    this.#pending.push({
      eventType: event.type,
      disposition: 'full-reducer',
      reason: 'edge family requires whole-graph reconciliation or producer revision',
    });
  }

  drainPlan(): IncrementalGraphDrainPlan {
    const rowLocalEventCount = this.#pending.filter(
      (item) => item.disposition === 'row-local',
    ).length;
    const fullReducerEventCount = this.#pending.length - rowLocalEventCount;
    return {
      initialized: this.#snapshotRevision !== null,
      pendingEventCount: this.#pending.length,
      rowLocalEventCount,
      fullReducerEventCount,
      canUseRowLocalOnly:
        this.#snapshotRevision !== null && this.#pending.length > 0 && fullReducerEventCount === 0,
      eventTypes: [...this.#pending],
    };
  }

  clearPending(): void {
    this.#pending = [];
  }
}

export const createIncrementalConnectionsGraphView = (): IncrementalConnectionsGraphView =>
  new IncrementalConnectionsGraphView();
