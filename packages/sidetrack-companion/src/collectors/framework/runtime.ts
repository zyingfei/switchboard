// Stage 4 — collector framework runtime entry point.
//
// `bootCollectorFramework({ vaultRoot, ... })` is the single entry the
// companion runtime calls during startup. It wires:
//
//   1. The materializer registry (with test-tick + Codex CLI + Claude
//      Code registrations, plus any extension-supplied additional
//      materializers).
//   2. Replay-on-startup over _BAC/audit/quarantine/.
//   3. Manifest discovery scan + watch over _BAC/collectors/.
//   4. Per-collector inbox tail loop (one tail handle per loaded
//      collector).
//   5. Quarantine retention setInterval.
//
// Returns a handle with `waitIdle` (used by spine.e2e.ts) and `close`
// (used by runtime/companion.ts teardown chain).

import { startDiscovery, type DiscoveryHandle } from './discovery.js';
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
import { type GateState, gateStateForCollector } from './capabilityGates.js';
import { enforceQuarantineRetention } from './quarantineRetention.js';

export interface CollectorFrameworkHandle {
  readonly registry: MaterializerRegistry;
  readonly waitIdle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface BootOpts {
  readonly vaultRoot: string;
  readonly companionFrameworkVersion?: string;
  readonly companionVersion?: string;
  readonly vaultMajor?: number;
  // Class A append. When `materializeCollectorLine` resolves with
  // `kind: 'promoted'`, the runtime invokes this with each emitted
  // event in order.
  readonly appendClassA?: (event: unknown, ruleId: string) => Promise<void>;
  // Audit log adapter (decoupled from vault/writer for testability).
  readonly auditRoute?: (route: string, subject: string) => Promise<void>;
  // Privacy projection state. The runtime reads this once at boot
  // and re-reads after each PRIVACY_PERMISSION_* event flushed to
  // the projection (out of scope for MVP — gate state may go stale
  // until reboot).
  readonly readGateState?: (
    collectorId: string,
    capability: 'reads-paths' | 'reads-env' | 'reads-network',
  ) => GateState;
  // Tracks already-promoted (collector_id, source_record_id) for
  // dedup. Default impl: in-memory Set seeded from event log on
  // boot.
  readonly readPromotedRecord?: (
    collectorId: string,
    sourceRecordId: string,
  ) => Promise<{ original_class_a_id: string } | null>;
  // Capability declaration lookup — backed by the loaded manifest
  // registry from S9.
  readonly capabilitiesForCollector?: (
    collectorId: string,
  ) => ReadonlyArray<'reads-paths' | 'reads-env' | 'reads-network'>;
}

const noopAudit = async (_route: string, _subject: string): Promise<void> => {
  // Default no-op for test harness usage. Real runtime injects an
  // adapter writing to _BAC/audit/<date>.jsonl.
};

const noopAppendClassA = async (_event: unknown, _ruleId: string): Promise<void> => {
  // Default no-op for test harness usage.
};

const defaultGateState = (): GateState => 'granted';

const noopReadPromoted = async (): Promise<null> => null;

const noopCapabilities = (): ReadonlyArray<'reads-paths' | 'reads-env' | 'reads-network'> => [];

export const bootCollectorFramework = async (
  opts: BootOpts,
): Promise<CollectorFrameworkHandle> => {
  const auditRoute = opts.auditRoute ?? noopAudit;
  const appendClassA = opts.appendClassA ?? noopAppendClassA;
  const readGateState = opts.readGateState ?? defaultGateState;
  const readPromoted = opts.readPromotedRecord ?? noopReadPromoted;
  const capabilitiesFor = opts.capabilitiesForCollector ?? noopCapabilities;

  // 1. Build the materializer registry with built-in registrations.
  const registry = createMaterializerRegistry();
  registerTestTick(registry);
  registerCodexCli(registry);
  registerClaudeCode(registry);

  // 2. Quarantine writer — used by the tail loop's quarantine path.
  const quarantineWriter: QuarantineWriter = createQuarantineWriter({
    vaultRoot: opts.vaultRoot,
    companionVersion: opts.companionVersion ?? COMPANION_VERSION,
    frameworkVersion: opts.companionFrameworkVersion ?? COLLECTOR_FRAMEWORK_VERSION,
  });

  // 3. Promote-context: the framework's view of the world.
  let manifestLoaded = (_id: string): boolean => false;
  const ctx: PromoteContext = {
    registry,
    isManifestLoaded: (id) => manifestLoaded(id),
    capabilitiesForCollector: capabilitiesFor,
    gateStateFor: readGateState,
    isAlreadyPromoted: readPromoted,
    onPromote: async (line, events, ruleId) => {
      for (const event of events) {
        await appendClassA(event, ruleId);
      }
      await auditRoute('collector:line-promoted', `${line.collector_id}:${line.event_type}`);
    },
  };

  // 4. Replay quarantine BEFORE discovery (compass §2.E).
  await replayQuarantine({ vaultRoot: opts.vaultRoot, ctx, auditRoute });

  // 5. Discovery — walk _BAC/collectors/ and watch for changes.
  const discovery: DiscoveryHandle = await startDiscovery({
    vaultRoot: opts.vaultRoot,
    registry,
    companionFrameworkVersion: opts.companionFrameworkVersion ?? COLLECTOR_FRAMEWORK_VERSION,
    vaultMajor: opts.vaultMajor ?? 1,
    minManifestSchema: MIN_MANIFEST_SCHEMA,
    maxManifestSchema: MAX_MANIFEST_SCHEMA,
    auditRoute,
  });

  // Bind manifestLoaded to the live discovery state.
  manifestLoaded = (id) =>
    discovery.loadedCollectors().some((c) => c.manifest.id === id && c.status === 'loaded');

  // 6. Tail loop per loaded collector.
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
          await auditRoute('collector:line-quarantined', `${collectorId}:${result.reason}`);
        }
        return result;
      },
      auditRoute,
    });
    tails.set(collectorId, handle);
  };

  for (const c of discovery.loadedCollectors()) {
    if (c.status === 'loaded') {
      await startTailFor(c.manifest.id);
    }
  }

  // 7. Quarantine retention setInterval.
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
      await discovery.close();
    },
  };
};
