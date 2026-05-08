import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  decideLoad,
  parseManifestTOML,
  type CollectorManifest,
  type ManifestRejectionReason,
} from './manifest.js';
import { type MaterializerRegistry } from './materializer.js';
import { manifestRootFor, validCollectorId } from '../../vault/inbox.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoadedCollector {
  readonly manifest: CollectorManifest;
  readonly status: 'loaded' | 'load-failed';
  readonly warnings: readonly string[];
  readonly loadedAt: string;
  readonly rejectedReason?: ManifestRejectionReason;
}

export interface DiscoveryHandle {
  readonly loadedCollectors: () => readonly LoadedCollector[];
  readonly close: () => Promise<void>;
}

export interface DiscoveryOpts {
  readonly vaultRoot: string;
  readonly registry: MaterializerRegistry;
  readonly companionFrameworkVersion: string;
  readonly vaultMajor: number;
  readonly minManifestSchema: number;
  readonly maxManifestSchema: number;
  readonly auditRoute: (route: string, subject: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TOML_FILENAME = 'collector.toml';

/** Map from rejection reason to the audit route string. */
const rejectionAuditRoute = (reason: ManifestRejectionReason): string => {
  switch (reason) {
    case 'manifest-too-new':
      return 'collector:manifest-too-new';
    case 'manifest-too-old':
      return 'collector:manifest-too-old';
    case 'requires-companion-not-satisfied':
      return 'collector:manifest-requires-companion-not-satisfied';
    case 'requires-vault-not-satisfied':
      return 'collector:manifest-requires-vault-not-satisfied';
    case 'no-emits-registered':
      return 'collector:manifest-no-emits-registered';
    case 'manifest-spawn-policy-unsupported':
      return 'collector:manifest-spawn-policy-unsupported';
    case 'parse-failed':
      return 'collector:manifest-parse-failed';
    case 'schema-failed':
      return 'collector:manifest-schema-failed';
  }
};

// ---------------------------------------------------------------------------
// Core evaluation: read + parse + decide for one collector id
// ---------------------------------------------------------------------------

interface EvalResult {
  readonly entry: LoadedCollector;
  readonly id: string;
}

const evaluateCollector = async (
  collectorsRoot: string,
  id: string,
  opts: DiscoveryOpts,
): Promise<EvalResult | null> => {
  const tomlPath = join(collectorsRoot, id, TOML_FILENAME);
  let raw: string;
  try {
    raw = await readFile(tomlPath, 'utf8');
  } catch {
    // File not found or unreadable — silently skip.
    return null;
  }

  const parsed = parseManifestTOML(raw);
  if (!parsed.ok) {
    await opts.auditRoute('collector:manifest-parse-failed', id);
    return null;
  }

  const ctx = {
    companionFrameworkVersion: opts.companionFrameworkVersion,
    vaultMajor: opts.vaultMajor,
    minManifestSchema: opts.minManifestSchema,
    maxManifestSchema: opts.maxManifestSchema,
    registeredTuples: opts.registry.allTuples(),
    maxKnownPayloadVersionFor: (cid: string, event_type: string) =>
      opts.registry.maxKnownPayloadVersionFor(cid, event_type),
  };

  const decision = decideLoad(parsed.manifest, ctx);
  const loadedAt = new Date().toISOString();

  if ('rejected' in decision) {
    const { reason } = decision.rejected;
    await opts.auditRoute(rejectionAuditRoute(reason), id);
    return {
      id,
      entry: {
        manifest: parsed.manifest,
        status: 'load-failed',
        warnings: [],
        loadedAt,
        rejectedReason: reason,
      },
    };
  }

  // accepted
  await opts.auditRoute('collector:manifest-loaded', id);
  return {
    id,
    entry: {
      manifest: decision.accepted.manifest,
      status: 'loaded',
      warnings: decision.accepted.warnings,
      loadedAt,
    },
  };
};

// ---------------------------------------------------------------------------
// startDiscovery
// ---------------------------------------------------------------------------

export const startDiscovery = async (opts: DiscoveryOpts): Promise<DiscoveryHandle> => {
  const collectorsRoot = manifestRootFor(opts.vaultRoot);

  // In-memory registry: collectorId → LoadedCollector
  const registry = new Map<string, LoadedCollector>();

  // ---------------------------------------------------------------------------
  // Initial scan
  // ---------------------------------------------------------------------------
  let entries: string[] = [];
  try {
    entries = await readdir(collectorsRoot);
  } catch {
    // No collectors directory yet — that is fine.
  }

  await Promise.all(
    entries
      .filter((name) => validCollectorId(name))
      .map(async (id) => {
        const result = await evaluateCollector(collectorsRoot, id, opts);
        if (result !== null) {
          registry.set(result.id, result.entry);
        }
      }),
  );

  // ---------------------------------------------------------------------------
  // fs.watch + 200ms debounce
  // ---------------------------------------------------------------------------
  const debounceMs = 200;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let watcher: ReturnType<typeof watch> | null = null;

  const handleChange = (filename: string): void => {
    // filename is relative to collectorsRoot, e.g. "my.collector/collector.toml"
    const parts = filename.split(/[/\\]/);
    if (parts.length !== 2) return;
    const idCandidate = parts[0];
    const tomlPart = parts[1];
    if (idCandidate === undefined || tomlPart !== TOML_FILENAME) return;
    if (!validCollectorId(idCandidate)) return;
    const id: string = idCandidate;

    const previous = debounceTimers.get(id);
    if (previous !== undefined) clearTimeout(previous);

    debounceTimers.set(
      id,
      setTimeout(() => {
        debounceTimers.delete(id);
        void (async () => {
          const previous_entry = registry.get(id);
          const result = await evaluateCollector(collectorsRoot, id, opts);
          if (result === null) return;

          // Detect a meaningful state change: status or rejection reason changed.
          const changed =
            previous_entry === undefined ||
            previous_entry.status !== result.entry.status ||
            previous_entry.rejectedReason !== result.entry.rejectedReason;

          registry.set(result.id, result.entry);

          if (changed && previous_entry !== undefined) {
            await opts.auditRoute('collector:manifest-reloaded', id);
          }
        })();
      }, debounceMs),
    );
  };

  try {
    watcher = watch(collectorsRoot, { recursive: true }, (_event, filename) => {
      if (filename === null) return;
      // normalize to forward-slash-relative path under collectorsRoot
      const rel = relative(collectorsRoot, join(collectorsRoot, filename));
      handleChange(rel);
    });
  } catch {
    // collectorsRoot may not exist; watcher stays null, which is fine.
  }

  // ---------------------------------------------------------------------------
  // Handle
  // ---------------------------------------------------------------------------
  return {
    loadedCollectors: () => [...registry.values()],
    close: async () => {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      if (watcher !== null) watcher.close();
    },
  };
};
