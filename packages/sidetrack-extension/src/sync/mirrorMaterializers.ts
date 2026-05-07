// Sync Contract v1 / Class F adoption — wraps the existing
// `mirrorRemoteX` functions in `state.ts` as PluginMaterializer
// instances. Each function was already Class F-compliant by
// behavior (read chrome.storage list, apply projection update,
// write back). This module gives them the formal interface so
// the side panel + future health surface can iterate over a
// uniform set of plugin-tier materializers.
//
// Migration is non-invasive: the existing background.ts SSE
// subscribers continue to call mirrorRemoteX directly, and these
// wrapper instances delegate to the same functions. A future
// stage may consolidate the SSE wiring around the materializer
// interface; for now the contract surface is what matters.

import {
  type RemoteDispatchProjection,
  type RemoteQueueItemProjection,
  type RemoteThreadProjection,
  type RemoteWorkstreamProjection,
  mirrorRemoteDispatch,
  mirrorRemoteQueueItem,
  mirrorRemoteThread,
  mirrorRemoteWorkstream,
  readCachedDispatches,
  readQueueItems,
  readThreads,
  readWorkstreams,
} from '../background/state';
import type { DispatchEventRecord } from '../dispatch/types';
import type { QueueItem, TrackedThread, WorkstreamNode } from '../workboard';
import { DEFAULT_PLUGIN_BUDGETS } from './budgetConfig';
import type {
  AdmitResult,
  ExtendedQuery,
  ExtendedResult,
  PluginMaterializer,
  PluginMaterializerHealth,
} from './pluginMaterializer';
import { buildScopedResult } from './resultScope';

const noOpAdmit = async (): Promise<AdmitResult> => ({ ok: true, tier: 'active' as const });
const noOpDrain = async (): Promise<{ uploaded: number; remaining: number }> => ({
  uploaded: 0,
  remaining: 0,
});
const noOpExport = async (): Promise<{ exported: number; archivePath: string }> => ({
  exported: 0,
  archivePath: '',
});

const baseHealth = (
  count: number,
  budget: number,
  surface: string,
): PluginMaterializerHealth => ({
  status: count > budget * 0.9 ? 'degraded' : 'healthy',
  activeSetSize: count,
  activeSetBudget: budget,
  spoolSize: 0,
  spoolBudget: DEFAULT_PLUGIN_BUDGETS.spoolBytes,
  // companionReachable is owned by the runtime status check; the
  // mirror materializers are companion-agnostic.
  companionReachable: true,
  lastReconcileAt: null,
  lastError: null,
  failedExplicitCount: 0,
  droppedPassiveCount: 0,
  // surface name is used only for narrative; the PluginMaterializer
  // identity is in `name` below. Suppress unused.
});

const noFetch = async <T>(): Promise<ExtendedResult<T>> =>
  buildScopedResult<T>('plugin-active-only-companion-unreachable', []);

// -----------------------------------------------------------------
// Threads — mirrors RemoteThreadProjection into sidetrack.threads
// -----------------------------------------------------------------
export const threadsPluginMaterializer: PluginMaterializer<RemoteThreadProjection> = {
  name: 'threads',
  // User actions for threads go through the companion HTTP route,
  // not through the plugin tier. admitLocal is a no-op; the
  // PluginMaterializer interface keeps it for future surfaces
  // (browser-timeline) that DO admit locally.
  admitLocal: noOpAdmit,
  mirrorFromCompanion: (projection) => mirrorRemoteThread(projection),
  fetchExtended: noFetch as (q: ExtendedQuery) => Promise<ExtendedResult<RemoteThreadProjection>>,
  drainSpoolToCompanion: noOpDrain,
  exportSpoolToArchive: noOpExport,
  health: () => {
    // readThreads is async; health() is sync per the interface.
    // Return a snapshot from a recent companionReachable check
    // semantically; for production we kick off a refresh in
    // background.ts. The synchronous return here uses defaults
    // until that refresh lands.
    return baseHealth(0, DEFAULT_PLUGIN_BUDGETS.activeSetCount['threads'] ?? 200, 'threads');
  },
};

// Async health snapshot — the interface's health() is sync, but
// callers that want fresh counts can call this directly.
export const threadsHealthSnapshot = async (): Promise<PluginMaterializerHealth> => {
  const items: readonly TrackedThread[] = await readThreads();
  return baseHealth(
    items.length,
    DEFAULT_PLUGIN_BUDGETS.activeSetCount['threads'] ?? 200,
    'threads',
  );
};

// -----------------------------------------------------------------
// Workstreams
// -----------------------------------------------------------------
export const workstreamsPluginMaterializer: PluginMaterializer<RemoteWorkstreamProjection> = {
  name: 'workstreams',
  admitLocal: noOpAdmit,
  mirrorFromCompanion: (projection) => mirrorRemoteWorkstream(projection),
  fetchExtended: noFetch as (
    q: ExtendedQuery,
  ) => Promise<ExtendedResult<RemoteWorkstreamProjection>>,
  drainSpoolToCompanion: noOpDrain,
  exportSpoolToArchive: noOpExport,
  health: () =>
    baseHealth(0, DEFAULT_PLUGIN_BUDGETS.activeSetCount['workstreams'] ?? 100, 'workstreams'),
};

export const workstreamsHealthSnapshot = async (): Promise<PluginMaterializerHealth> => {
  const items: readonly WorkstreamNode[] = await readWorkstreams();
  return baseHealth(
    items.length,
    DEFAULT_PLUGIN_BUDGETS.activeSetCount['workstreams'] ?? 100,
    'workstreams',
  );
};

// -----------------------------------------------------------------
// Queue items
// -----------------------------------------------------------------
export const queueItemsPluginMaterializer: PluginMaterializer<RemoteQueueItemProjection> = {
  name: 'queue',
  admitLocal: noOpAdmit,
  mirrorFromCompanion: (projection) => mirrorRemoteQueueItem(projection),
  fetchExtended: noFetch as (
    q: ExtendedQuery,
  ) => Promise<ExtendedResult<RemoteQueueItemProjection>>,
  drainSpoolToCompanion: noOpDrain,
  exportSpoolToArchive: noOpExport,
  health: () =>
    baseHealth(0, DEFAULT_PLUGIN_BUDGETS.activeSetCount['queue'] ?? 100, 'queue'),
};

export const queueItemsHealthSnapshot = async (): Promise<PluginMaterializerHealth> => {
  const items: readonly QueueItem[] = await readQueueItems();
  return baseHealth(
    items.length,
    DEFAULT_PLUGIN_BUDGETS.activeSetCount['queue'] ?? 100,
    'queue',
  );
};

// -----------------------------------------------------------------
// Recent dispatches
// -----------------------------------------------------------------
export const dispatchesPluginMaterializer: PluginMaterializer<RemoteDispatchProjection> = {
  name: 'dispatches',
  admitLocal: noOpAdmit,
  mirrorFromCompanion: (projection) => mirrorRemoteDispatch(projection),
  fetchExtended: noFetch as (
    q: ExtendedQuery,
  ) => Promise<ExtendedResult<RemoteDispatchProjection>>,
  drainSpoolToCompanion: noOpDrain,
  exportSpoolToArchive: noOpExport,
  health: () =>
    baseHealth(0, DEFAULT_PLUGIN_BUDGETS.activeSetCount['dispatches'] ?? 50, 'dispatches'),
};

export const dispatchesHealthSnapshot = async (): Promise<PluginMaterializerHealth> => {
  const items: readonly DispatchEventRecord[] = await readCachedDispatches();
  return baseHealth(
    items.length,
    DEFAULT_PLUGIN_BUDGETS.activeSetCount['dispatches'] ?? 50,
    'dispatches',
  );
};

// All four plugin-tier materializers as a registry. Side-panel
// health rendering iterates over this; future PluginMaterializer
// additions (browser-timeline) just append to this list.
export const PLUGIN_MATERIALIZERS = [
  threadsPluginMaterializer,
  workstreamsPluginMaterializer,
  queueItemsPluginMaterializer,
  dispatchesPluginMaterializer,
] as const;

export const PLUGIN_HEALTH_SNAPSHOTS: readonly (() => Promise<PluginMaterializerHealth>)[] = [
  threadsHealthSnapshot,
  workstreamsHealthSnapshot,
  queueItemsHealthSnapshot,
  dispatchesHealthSnapshot,
];
