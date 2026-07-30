// Routing-bucket and collector routes: the bucket registry read/write and
// the collector framework's list/replay endpoints.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { bucketsPutSchema } from '../schemas.js';

import { readBody } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const bucketsRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/buckets$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { items: (await context.bucketRegistry?.readBuckets()) ?? [] },
    ],
  },
  // Stage 4 — collector framework status + replay routes.
  {
    method: 'GET',
    pattern: /^\/v1\/collectors$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.collectorFramework === undefined) {
        return [503, { error: 'collector framework not enabled' }];
      }
      const loaded = context.collectorFramework.loadedCollectors();
      const collectors = await Promise.all(
        loaded.map(async (entry) => {
          // Defensive extraction — the framework's LoadedCollector
          // shape is widened to `unknown` at the HTTP context boundary
          // (see CompanionHttpConfig.collectorFramework comment).
          const e = entry as {
            manifest: {
              id: string;
              name: string;
              version: string;
              manifest_schema: number;
              emits: readonly {
                event_type: string;
                payload_version: number;
                stability?: 'alpha' | 'beta' | 'stable' | 'deprecated';
              }[];
              capabilities: {
                'reads-paths'?: readonly string[];
                'reads-env'?: readonly string[];
                'reads-network'?: boolean;
                'default-enabled'?: boolean;
              };
            };
            status: 'loaded' | 'load-failed';
            rejectedReason?: string;
          };
          const id = e.manifest.id;
          const fw = context.collectorFramework!;
          const quarantineCount = await fw.quarantineCountFor(id);
          const resolveGate = fw.resolveGate;
          const lastPromotedAtFor = fw.lastPromotedAtFor;
          // capability_gates: per-(collector_id, capability) gate
          // state. Only includes capabilities the collector actually
          // declared — declaring no `reads-paths` paths means no
          // 'reads-paths' key appears here. When the framework
          // doesn't expose a resolver, we surface 'pending' so the
          // UI can show a neutral state rather than a misleading
          // 'granted'.
          const capabilityGates: Record<string, 'granted' | 'revoked' | 'pending'> = {};
          if (
            e.manifest.capabilities['reads-paths'] !== undefined &&
            e.manifest.capabilities['reads-paths'].length > 0
          ) {
            capabilityGates['reads-paths'] = resolveGate
              ? resolveGate(id, 'reads-paths')
              : 'pending';
          }
          if (
            e.manifest.capabilities['reads-env'] !== undefined &&
            e.manifest.capabilities['reads-env'].length > 0
          ) {
            capabilityGates['reads-env'] = resolveGate ? resolveGate(id, 'reads-env') : 'pending';
          }
          if (e.manifest.capabilities['reads-network'] === true) {
            capabilityGates['reads-network'] = resolveGate
              ? resolveGate(id, 'reads-network')
              : 'pending';
          }
          return {
            collector_id: id,
            name: e.manifest.name,
            version: e.manifest.version,
            manifest_schema: e.manifest.manifest_schema,
            status: e.status,
            ...(e.rejectedReason === undefined ? {} : { rejected_reason: e.rejectedReason }),
            emits: e.manifest.emits,
            capabilities: {
              reads_paths: e.manifest.capabilities['reads-paths'] ?? [],
              reads_env: e.manifest.capabilities['reads-env'] ?? [],
              reads_network: e.manifest.capabilities['reads-network'] ?? false,
              default_enabled: e.manifest.capabilities['default-enabled'] ?? true,
            },
            capability_gates: capabilityGates,
            quarantine_count: quarantineCount,
            last_promoted_at: lastPromotedAtFor ? lastPromotedAtFor(id) : null,
          };
        }),
      );
      return [200, { collectors }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/collectors\/(?<collectorId>[a-z0-9.-]+)\/replay$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (context.collectorFramework === undefined) {
        return [503, { error: 'collector framework not enabled' }];
      }
      const collectorId = match.collectorId;
      if (collectorId === undefined || collectorId.length === 0) {
        return [400, { error: 'invalid collector id' }];
      }
      const result = await context.collectorFramework.replayCollector(collectorId);
      return [
        200,
        {
          collector_id: collectorId,
          scanned: result.scanned,
          promoted: result.promoted,
          still_quarantined: result.stillQuarantined,
        },
      ];
    },
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/buckets$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.bucketRegistry === undefined) {
        throw new Error('Bucket registry is unavailable.');
      }
      const input = bucketsPutSchema.parse(await readBody(request));
      await context.bucketRegistry.writeBuckets(input.buckets);
      return [200, { items: await context.bucketRegistry.readBuckets() }];
    },
  },
];
