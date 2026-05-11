import type { ConnectionsStore } from '../../connections/snapshot.js';
import type { TimelineStore } from '../../timeline/projection.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer } from './materializer.js';
export interface CreateConnectionsMaterializerDeps {
    readonly vaultRoot: string;
    readonly eventLog: EventLog;
    readonly timelineStore: TimelineStore;
    readonly store: ConnectionsStore;
}
export declare const createConnectionsMaterializer: (deps: CreateConnectionsMaterializerDeps) => Materializer;
//# sourceMappingURL=connectionsMaterializer.d.ts.map