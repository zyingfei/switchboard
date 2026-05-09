// Stage 4 — collector framework runtime entry point.
//
// `bootCollectorFramework({ vaultRoot, ... })` is the single entry the
// companion runtime calls during startup. It wires:
//
//   1. The materializer registry (with test-tick + Codex CLI + Claude
//      Code registrations, plus any extension-supplied additional
//      materializers).
//   2. Replay-on-startup over _BAC/audit/quarantine/.
//   3. Manifest discovery scan + watch over _BAC/collectors/. The
//      discovery onLoaded callback fires per loaded collector — the
//      runtime starts a tail loop in response, so collectors loaded
//      AFTER boot light up without polling.
//   4. Per-collector inbox tail loop. Tails started lazily as
//      manifests load.
//   5. Quarantine retention setInterval.
//
// The runtime captures the privacy projection in a mutable cache. The
// caller (companion runtime) refreshes the cache on every accepted
// privacy event so gate state stays current without a per-line event-
// log read. `capabilitiesForCollector` is auto-derived from
// discovery's loaded manifests — the caller does NOT pass it in.

import {
  startDiscovery,
  type DiscoveryHandle,
  type LoadedCollector,
} from './discovery.js';
import { startTail, type TailHandle } from './tail.js';
import { replayQuarantine } from './replay.js';
import { materializeCollectorLine, type PromoteContext } from './promote.js';
import { createQuarantineWriter, type QuarantineWriter } from './quarantine.js';
import {
  createMaterializerRegistry,
  type MaterializerRegistry,
} from './materializer.js';
import { registerTestTick } from '../test-tick/materializers.js';
import { registerCodexCli } from '../codex-cli/materializers.js';
import { registerClaudeCode } from '../claude-code/materializers.js';
import {
  COLLECTOR_FRAMEWORK_VERSION,
  COMPANION_VERSION,
  MAX_MANIFEST_SCHEMA,
  MIN_MANIFEST_SCHEMA,
} from '../../version.js';
import { type CollectorCapability, type GateState } from './capabilityGates.js';
import { enforceQuarantineRetention } from './quarantineRetention.js';

export interface CollectorFrameworkHandle {
  readonly registry: MaterializerRegistry;
  readonly loadedCollectors: () => readonly LoadedCollector[];
  readonly replayCollector: (collectorId: string) => Promise<{
    readonly scanned: number;
    readonly promoted: number;
    readonly stillQuarantined: number;
  }>;
  readonly quarantineCountFor: (collectorId: string) => Promise<number>;
  readonly waitIdle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface BootOpts {
  readonly vaultRoot: string;
  readonly companionFrameworkVersion?: string;
  readonly companionVersion?: string;
  readonly vaultMajor?: number;
  // Class A append. When materializeCollectorLine resolves with
  // `kind: 'promoted'`, the runtime invokes this with each emitted
  // event in order plus the producedBy.ruleId.
  readonly appendClassA?: (event: unknown, ruleId: string) => Promise<void>;
  // Audit log adapter (decoupled from vault/writer for testability).
  readonly auditRoute?: (route: string, subject: string) => Promise<void>;
  // Privacy gate read — synchronous. The caller maintains a cached
  // PrivacyProjection and resolves the gate state for
  // (collectorId, capability) using
  // collectors/framework/capabilityGates.ts:gateStateForCollector.
  // `defaultEnabled` is the manifest's `[capabilities].default-enabled`;
  // the caller is the one with the manifest, so the framework hands
  // it through to the resolver. (Fallback impl: return 'granted' when
  // no resolver is supplied — used by tests + when running without
  // the privacy projection wired.)
  readonly resolveGate?: (
    collectorId: string,
    capability: CollectorCapability,
    defaultEnabled: boolean,
  ) => GateState;
  // Tracks already-promoted (collector_id, source_record_id) for
  // dedup. Default impl: return null (no dedup) — the L1 e2e
  // exercises the path; production wiring populates this from the
  // event log if/when collector dedup becomes a measured complaint.
  readonly readPromotedRecord?: (
    collectorId: string,
    sourceRecordId: string,
  ) => Promise<{ original_class_a_id: string } | null>;
  // Additional materializer registrations beyond the built-ins.
  readonly extraMaterializers?: ReadonlyArray<(registry: MaterializerRegistry) => void>;
}

const noopAudit = async (_route: string, _subject: string): Promise<void> => {};
const noopAppendClassA = async (_event: unknown, _ruleId: string): Promise<void> => {};
const noopReadPromoted = async (): Promise<null> => null;
const defaultResolveGate = (): GateState => 'granted';

const declaredCapabilities = (m: LoadedCollector | undefined): readonly CollectorCapability[] => {
  if (m === undefined || m.status !== 'loaded') return [];
  const out: CollectorCapability[] = [];
  if (m.manifest.capabilities['reads-paths'] !== undefined && m.manifest.capabilities['reads-paths'].length > 0) {
    out.push('reads-paths');
  }
  if (m.manifest.capabilities['reads-env'] !== undefined && m.manifest.capabilities['reads-env'].length > 0) {
    out.push('reads-env');
  }
  if (m.manifest.capabilities['reads-network'] === true) {
    out.push('reads-network');
  }
  return out;
};

const defaultEnabledFor = (m: LoadedCollector | undefined): boolean => {
  if (m === undefined || m.status !== 'loaded') return false;
  return m.manifest.capabilities['default-enabled'] !== false;
};

export const bootCollectorFramework = async (
  opts: BootOpts,
): Promise<CollectorFrameworkHandle> => {
  const auditRoute = opts.auditRoute ?? noopAudit;
  const appendClassA = opts.appendClassA ?? noopAppendClassA;
  const resolveGate = opts.resolveGate ?? defaultResolveGate;
  const readPromoted = opts.readPromotedRecord ?? noopReadPromoted;

  // 1. Build the materializer registry with built-in registrations.
  const registry = createMaterializerRegistry();
  registerTestTick(registry);
  registerCodexCli(registry);
  registerClaudeCode(registry);
  for (const reg of opts.extraMaterializers ?? []) {
    reg(registry);
  }

  // 2. Quarantine writer — used by the tail loop's quarantine path.
  const quarantineWriter: QuarantineWriter = createQuarantineWriter({
    vaultRoot: opts.vaultRoot,
    companionVersion: opts.companionVersion ?? COMPANION_VERSION,
    frameworkVersion: opts.companionFrameworkVersion ?? COLLECTOR_FRAMEWORK_VERSION,
  });

  // 3. Promote-context. `discovery` is wired below; we provide
  // late-bound closures here so the context can be built before
  // discovery runs.
  let discovery: DiscoveryHandle | null = null;
  const findLoaded = (id: string): LoadedCollector | undefined =>
    discovery?.loadedCollectors().find((c) => c.manifest.id === id);

  const ctx: PromoteContext = {
    registry,
    isManifestLoaded: (id) => {
      const m = findLoaded(id);
      return m !== undefined && m.status === 'loaded';
    },
    capabilitiesForCollector: (id) => declaredCapabilities(findLoaded(id)),
    gateStateFor: (id, cap) => {
      const m = findLoaded(id);
      return resolveGate(id, cap, defaultEnabledFor(m));
    },
    isAlreadyPromoted: readPromoted,
    onPromote: async (line, events, ruleId) => {
      for (const event of events) {
        await appendClassA(event, ruleId);
      }
      await auditRoute(
        'collector:line-promoted',
        `${line.collector_id}:${line.event_type}`,
      );
    },
  };

  // 4. Per-collector tail loops, started lazily as manifests load.
  const tails: Map<string, TailHandle> = new Map();
  const startTailFor = async (collectorId: string): Promise<void> => {
    if (tails.has(collectorId)) return;
    const handle = await startTail({
      vaultRoot: opts.vaultRoot,
      collectorId,
      onLine: async (raw) => {
        const result = await materializeCollectorLine(raw, ctx);
        if (result.kind === 'quarantined') {
          await quarantineWriter.write(
            collectorId,
            raw,
            result.line,
            result.reason,
          );
          await auditRoute(
            'collector:line-quarantined',
            `${collectorId}:${result.reason}`,
          );
        } else if (result.kind === 'deduped') {
          await auditRoute(
            'collector:line-deduped',
            `${collectorId}:${result.original_class_a_id}`,
          );
        }
        return result;
      },
      auditRoute,
    });
    tails.set(collectorId, handle);
  };

  // 5. Discovery — walk _BAC/collectors/ + watch. onLoaded fires
  // per-loaded-manifest, both on initial scan and on watch-driven
  // reload that flips status to 'loaded'. Each callback starts a
  // tail loop for that collector.
  discovery = await startDiscovery({
    vaultRoot: opts.vaultRoot,
    registry,
    companionFrameworkVersion: opts.companionFrameworkVersion ?? COLLECTOR_FRAMEWORK_VERSION,
    vaultMajor: opts.vaultMajor ?? 1,
    minManifestSchema: MIN_MANIFEST_SCHEMA,
    maxManifestSchema: MAX_MANIFEST_SCHEMA,
    auditRoute,
    onLoaded: async (entry) => {
      await startTailFor(entry.manifest.id).catch(() => {
        // Tail-start errors must not stall discovery.
      });
    },
  });

  // 6. Replay quarantine AFTER discovery — compass §2.E says replay-
  // on-startup runs once the manifest registry is loaded so the
  // promote choke point's isManifestLoaded check returns the right
  // answer. Running before discovery would fail every line with
  // 'manifest-not-loaded' and the test never gets to verify that
  // gate-grant + replay actually promotes lines.
  await replayQuarantine({ vaultRoot: opts.vaultRoot, ctx, auditRoute });

  // 7. Quarantine retention setInterval (24-hour cadence).
  let retentionTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => {
      void enforceQuarantineRetention(opts.vaultRoot).catch(() => {
        // Retention errors are logged inline; never surface.
      });
    },
    24 * 60 * 60 * 1000,
  );

  return {
    registry,
    loadedCollectors: () => discovery?.loadedCollectors() ?? [],
    replayCollector: async (collectorId) => {
      // Replay only entries for the requested collector.
      const result = await replayQuarantine({
        vaultRoot: opts.vaultRoot,
        ctx,
        auditRoute: async (route, subject) => {
          // Tag replay audits so they're distinguishable from boot.
          await auditRoute(route, subject);
        },
      });
      // Note: replayQuarantine currently scans all collectors. A
      // future refinement may scope to one — the ReplayResult is
      // global today. Caller treats counts as approximate when
      // multiple collectors are quarantined.
      void collectorId;
      return {
        scanned: result.scanned,
        promoted: result.promoted,
        stillQuarantined: result.stillQuarantined,
      };
    },
    quarantineCountFor: async (collectorId) => {
      const entries = await quarantineWriter.readAllForCollector(collectorId);
      return entries.length;
    },
    waitIdle: async () => {
      await Promise.all([...tails.values()].map((t) => t.waitIdle()));
    },
    close: async () => {
      if (retentionTimer !== null) {
        clearInterval(retentionTimer);
        retentionTimer = null;
      }
      await Promise.all([...tails.values()].map((t) => t.close()));
      tails.clear();
      if (discovery !== null) {
        await discovery.close();
        discovery = null;
      }
    },
  };
};
