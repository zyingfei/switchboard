import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ANNOTATION_CREATED, isAnnotationCreatedPayload } from '../annotations/events.js';
import { DISPATCH_LINKED, isDispatchLinkedPayload } from '../dispatches/events.js';
import { createRevision } from '../domain/ids.js';
import { QUEUE_CREATED, isQueueCreatedPayload } from '../queue/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  THREAD_UPSERTED,
  isThreadUpsertedPayload,
} from '../threads/events.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import {
  WORKSTREAM_UPSERTED,
  isWorkstreamUpsertedPayload,
} from '../workstreams/events.js';
import {
  edgeIdFor,
  nodeIdFor,
  type ConnectionEdge,
  type ConnectionEdgeKind,
  type ConnectionNode,
  type ConnectionNodeKind,
  type ConnectionNodeMetadata,
  type ConnectionsSnapshot,
  type ConnectionsSnapshotScope,
} from './types.js';

export type { ConnectionsSnapshot } from './types.js';

// Sync Contract v1 / Class B — Connections snapshot reducer.
//
// Pure function over the merged event log + companion vault
// records. Same input → byte-equivalent output across replays and
// replicas. No wall-clock, no inference, no time-proximity edges.
//
// MVP edge set (12 deterministic edges):
//   thread_in_workstream                 thread.primaryWorkstreamId
//   workstream_parent_of                 workstream.parentId
//   dispatch_from_thread                 dispatch record sourceThreadId
//   dispatch_in_workstream               dispatch record workstreamId
//   dispatch_reply_landed_in_thread      dispatch.linked event
//   dispatch_requested_coding_session    dispatch record mcpRequest
//   queue_targets_thread / _workstream   queue.created event
//   reminder_for_thread                  reminder record threadId
//   coding_session_in_workstream         coding session workstreamId
//   timeline_same_url_as_thread          canonical-URL match
//   annotation_targets_thread            annotation URL matches thread URL

// Minimal record shapes pulled from the companion vault. Defined
// locally so this module doesn't depend on the HTTP schema package.
// The materializer's loader is responsible for producing these.

export interface ThreadVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly threadUrl?: string;
  readonly canonicalUrl?: string;
  readonly provider?: string;
  readonly lastSeenAt?: string;
  readonly primaryWorkstreamId?: string;
}

export interface WorkstreamVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly parentId?: string;
  readonly children?: readonly string[];
  readonly tags?: readonly string[];
  readonly privacy?: string;
}

export interface DispatchVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly target?: { readonly provider?: string };
  readonly status?: string;
  readonly createdAt?: string;
  readonly sourceThreadId?: string;
  readonly workstreamId?: string;
  readonly mcpRequest?: {
    readonly codingSessionId?: string;
  };
}

export interface QueueVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly scope?: string;
  readonly targetId?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly threadId?: string;
  readonly workstreamId?: string;
}

export interface ReminderVaultRecord {
  readonly bac_id?: string;
  readonly threadId: string;
  readonly provider?: string;
  readonly detectedAt?: string;
  readonly status?: string;
}

export interface CodingSessionVaultRecord {
  readonly bac_id: string;
  readonly workstreamId?: string;
  readonly tool?: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly name?: string;
  readonly attachedAt?: string;
  readonly lastSeenAt?: string;
  readonly status?: string;
}

export interface ConnectionsInput {
  readonly events: readonly AcceptedEvent[];
  readonly threads: readonly ThreadVaultRecord[];
  readonly workstreams: readonly WorkstreamVaultRecord[];
  readonly dispatches: readonly DispatchVaultRecord[];
  readonly queueItems: readonly QueueVaultRecord[];
  readonly reminders: readonly ReminderVaultRecord[];
  readonly codingSessions: readonly CodingSessionVaultRecord[];
  readonly timelineDays: readonly TimelineDayProjection[];
  readonly scope?: ConnectionsSnapshotScope;
}

// Internal accumulator for nodes — allows merging origin replica
// ids and merging metadata from multiple sources.
interface AccumNode {
  readonly id: string;
  readonly kind: ConnectionNodeKind;
  label: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  originReplicaIds: Set<string>;
  metadata: Record<string, unknown>;
}

const sortAlphaById = <T extends { id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const compactMetadata = (m: Record<string, unknown>): ConnectionNodeMetadata => {
  // Drop undefined entries so the same logical metadata produces
  // byte-identical JSON across runs.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  // Sort keys for deterministic JSON.stringify output.
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted as ConnectionNodeMetadata;
};

const upsertNode = (
  nodes: Map<string, AccumNode>,
  input: {
    kind: ConnectionNodeKind;
    key: string;
    label: string;
    observedAt?: string;
    replicaId?: string;
    metadata?: Record<string, unknown>;
  },
): AccumNode => {
  const id = nodeIdFor(input.kind, input.key);
  const existing = nodes.get(id);
  if (existing === undefined) {
    const node: AccumNode = {
      id,
      kind: input.kind,
      label: input.label,
      ...(input.observedAt === undefined
        ? {}
        : { firstSeenAt: input.observedAt, lastSeenAt: input.observedAt }),
      originReplicaIds: new Set<string>(input.replicaId !== undefined ? [input.replicaId] : []),
      metadata: { ...(input.metadata ?? {}) },
    };
    nodes.set(id, node);
    return node;
  }
  // Merge: keep the longer label (proxies "richer source"); extend
  // first/last seen; union replica ids; merge metadata (existing wins
  // unless the new value is more specific).
  if (input.label.length > existing.label.length) existing.label = input.label;
  if (input.observedAt !== undefined) {
    if (existing.firstSeenAt === undefined || input.observedAt < existing.firstSeenAt) {
      existing.firstSeenAt = input.observedAt;
    }
    if (existing.lastSeenAt === undefined || input.observedAt > existing.lastSeenAt) {
      existing.lastSeenAt = input.observedAt;
    }
  }
  if (input.replicaId !== undefined) existing.originReplicaIds.add(input.replicaId);
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    if (v === undefined) continue;
    if (existing.metadata[k] === undefined) existing.metadata[k] = v;
  }
  return existing;
};

// Same idempotency rule as nodes — same source observation across
// replays produces the same edge id, so re-runs collapse to a stable
// set.
const upsertEdge = (
  edges: Map<string, ConnectionEdge>,
  input: Omit<ConnectionEdge, 'id'>,
): void => {
  const id = edgeIdFor(input.kind, input.fromNodeId, input.toNodeId);
  // Keep the EARLIEST observedAt as the canonical "first observed
  // this connection" — same input → same output. Re-derives stable.
  const existing = edges.get(id);
  if (existing === undefined) {
    edges.set(id, { id, ...input });
    return;
  }
  if (input.observedAt < existing.observedAt) {
    edges.set(id, { id, ...input });
  }
};

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

// ---------------------------------------------------------------------------
// Pass 1: walk events, populate nodes + emit event-derived edges.
// Pass 2: walk vault records, hydrate node metadata + emit
//         vault-derived edges.
// Pass 3: cross-cutting joins (timeline ↔ thread URL, annotation ↔
//         thread URL).
// ---------------------------------------------------------------------------

export const buildConnectionsSnapshot = (
  input: ConnectionsInput,
): ConnectionsSnapshot => {
  const nodes = new Map<string, AccumNode>();
  const edges = new Map<string, ConnectionEdge>();
  let maxObservedAt = '';

  const trackObservedAt = (s: string | undefined): void => {
    if (s !== undefined && s > maxObservedAt) maxObservedAt = s;
  };

  // -------------------------------------------------------------------
  // Pass 1 — events: thread.upserted, workstream.upserted, dispatch.linked,
  // queue.created, annotation.created. Each produces a node and may emit
  // edges that are derivable from the event payload alone.
  // -------------------------------------------------------------------
  for (const event of input.events) {
    const observedAtIso = new Date(event.acceptedAtMs).toISOString();
    trackObservedAt(observedAtIso);
    const replicaId = event.dot.replicaId;

    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      const p = event.payload;
      const threadKey = p.bac_id;
      // The thread payload's lastSeenAt is the user-relevant
      // timestamp (the moment the user touched the thread); track
      // it for global maxObservedAt so the snapshot updatedAt
      // reflects user-perspective time, not just runner accept
      // time.
      trackObservedAt(p.lastSeenAt);
      upsertNode(nodes, {
        kind: 'thread',
        key: threadKey,
        label: p.title ?? p.threadUrl ?? threadKey,
        observedAt: p.lastSeenAt ?? observedAtIso,
        replicaId,
        metadata: {
          provider: p.provider,
          url: p.threadUrl,
          title: p.title,
          ...(p.primaryWorkstreamId === undefined
            ? {}
            : { workstreamId: p.primaryWorkstreamId }),
        },
      });
      if (p.primaryWorkstreamId !== undefined) {
        // Edge target may not exist yet; we create the workstream
        // node lazily so the edge has a valid endpoint either way.
        const wsKey = p.primaryWorkstreamId;
        upsertNode(nodes, {
          kind: 'workstream',
          key: wsKey,
          label: wsKey,
          observedAt: observedAtIso,
          replicaId,
        });
        const fromId = nodeIdFor('thread', threadKey);
        const toId = nodeIdFor('workstream', wsKey);
        upsertEdge(edges, {
          kind: 'thread_in_workstream',
          fromNodeId: fromId,
          toNodeId: toId,
          observedAt: observedAtIso,
          producedBy: {
            source: 'event-log',
            eventType: THREAD_UPSERTED,
            dot: { replicaId, seq: event.dot.seq },
          },
          confidence: 'explicit',
        });
      }
      continue;
    }

    if (event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload)) {
      const p = event.payload;
      upsertNode(nodes, {
        kind: 'workstream',
        key: p.bac_id,
        label: p.title ?? p.bac_id,
        observedAt: observedAtIso,
        replicaId,
        metadata: {
          title: p.title,
        },
      });
      if (typeof p.parentId === 'string' && p.parentId.length > 0) {
        upsertNode(nodes, {
          kind: 'workstream',
          key: p.parentId,
          label: p.parentId,
          observedAt: observedAtIso,
          replicaId,
        });
        upsertEdge(edges, {
          kind: 'workstream_parent_of',
          fromNodeId: nodeIdFor('workstream', p.parentId),
          toNodeId: nodeIdFor('workstream', p.bac_id),
          observedAt: observedAtIso,
          producedBy: {
            source: 'event-log',
            eventType: WORKSTREAM_UPSERTED,
            dot: { replicaId, seq: event.dot.seq },
          },
          confidence: 'explicit',
        });
      }
      continue;
    }

    if (event.type === DISPATCH_LINKED && isDispatchLinkedPayload(event.payload)) {
      const p = event.payload;
      // Both endpoint nodes — they're populated more richly by
      // vault records in pass 2; this lazy creation guarantees the
      // edge points at SOMETHING.
      upsertNode(nodes, {
        kind: 'dispatch',
        key: p.dispatchId,
        label: p.dispatchId,
        observedAt: observedAtIso,
        replicaId,
      });
      upsertNode(nodes, {
        kind: 'thread',
        key: p.threadId,
        label: p.threadId,
        observedAt: observedAtIso,
        replicaId,
      });
      upsertEdge(edges, {
        kind: 'dispatch_reply_landed_in_thread',
        fromNodeId: nodeIdFor('dispatch', p.dispatchId),
        toNodeId: nodeIdFor('thread', p.threadId),
        observedAt: observedAtIso,
        producedBy: {
          source: 'event-log',
          eventType: DISPATCH_LINKED,
          dot: { replicaId, seq: event.dot.seq },
        },
        confidence: 'explicit',
      });
      continue;
    }

    if (event.type === QUEUE_CREATED && isQueueCreatedPayload(event.payload)) {
      const p = event.payload;
      const label = p.text.length > 0 ? p.text.slice(0, 80) : p.bac_id;
      upsertNode(nodes, {
        kind: 'queue-item',
        key: p.bac_id,
        label,
        observedAt: observedAtIso,
        replicaId,
        metadata: {
          ...(p.status === undefined ? {} : { status: p.status }),
          title: label,
        },
      });
      if (typeof p.targetId === 'string' && p.targetId.length > 0) {
        if (p.scope === 'thread') {
          upsertNode(nodes, {
            kind: 'thread',
            key: p.targetId,
            label: p.targetId,
            observedAt: observedAtIso,
            replicaId,
          });
          upsertEdge(edges, {
            kind: 'queue_targets_thread',
            fromNodeId: nodeIdFor('queue-item', p.bac_id),
            toNodeId: nodeIdFor('thread', p.targetId),
            observedAt: observedAtIso,
            producedBy: { source: 'event-log', eventType: QUEUE_CREATED, dot: { replicaId, seq: event.dot.seq } },
            confidence: 'explicit',
          });
        } else if (p.scope === 'workstream') {
          upsertNode(nodes, {
            kind: 'workstream',
            key: p.targetId,
            label: p.targetId,
            observedAt: observedAtIso,
            replicaId,
          });
          upsertEdge(edges, {
            kind: 'queue_targets_workstream',
            fromNodeId: nodeIdFor('queue-item', p.bac_id),
            toNodeId: nodeIdFor('workstream', p.targetId),
            observedAt: observedAtIso,
            producedBy: { source: 'event-log', eventType: QUEUE_CREATED, dot: { replicaId, seq: event.dot.seq } },
            confidence: 'explicit',
          });
        }
      }
      continue;
    }

    if (event.type === ANNOTATION_CREATED && isAnnotationCreatedPayload(event.payload)) {
      const p = event.payload;
      upsertNode(nodes, {
        kind: 'annotation',
        key: p.bac_id,
        label: p.note.length > 0 ? p.note.slice(0, 80) : p.bac_id,
        observedAt: observedAtIso,
        replicaId,
        metadata: {
          url: p.url,
          title: p.pageTitle,
        },
      });
      // The annotation_targets_thread edge is materialized in
      // pass 3 (it requires URL matching against thread records).
      continue;
    }
  }

  // -------------------------------------------------------------------
  // Pass 2 — vault records. These provide rich metadata that the
  // event payloads don't carry (dispatch sourceThreadId, mcpRequest,
  // workstream.children, coding session details, reminders).
  // -------------------------------------------------------------------
  for (const t of input.threads) {
    upsertNode(nodes, {
      kind: 'thread',
      key: t.bac_id,
      label: t.title ?? t.threadUrl ?? t.bac_id,
      ...(t.lastSeenAt === undefined ? {} : { observedAt: t.lastSeenAt }),
      metadata: {
        ...(t.provider === undefined ? {} : { provider: t.provider }),
        ...(t.threadUrl === undefined ? {} : { url: t.threadUrl }),
        ...(t.canonicalUrl ?? t.threadUrl ? { canonicalUrl: t.canonicalUrl ?? t.threadUrl } : {}),
        ...(t.title === undefined ? {} : { title: t.title }),
      },
    });
  }
  for (const w of input.workstreams) {
    upsertNode(nodes, {
      kind: 'workstream',
      key: w.bac_id,
      label: w.title ?? w.bac_id,
      metadata: { title: w.title },
    });
    // Treat children[] as a richer source than parentId — a parent
    // record IS the source of truth for the parent_of relationship
    // (a child's parentId might lag if events arrive out of order).
    if (Array.isArray(w.children)) {
      for (const childId of w.children) {
        if (typeof childId !== 'string' || childId.length === 0) continue;
        upsertNode(nodes, { kind: 'workstream', key: childId, label: childId });
        upsertEdge(edges, {
          kind: 'workstream_parent_of',
          fromNodeId: nodeIdFor('workstream', w.bac_id),
          toNodeId: nodeIdFor('workstream', childId),
          observedAt: '',  // vault record without observedAt; sentinel sorts first
          producedBy: { source: 'workboard-state', recordId: w.bac_id },
          confidence: 'explicit',
        });
      }
    }
  }
  for (const d of input.dispatches) {
    trackObservedAt(d.createdAt);
    upsertNode(nodes, {
      kind: 'dispatch',
      key: d.bac_id,
      label: d.title ?? d.bac_id,
      ...(d.createdAt === undefined ? {} : { observedAt: d.createdAt }),
      metadata: {
        ...(d.target?.provider === undefined ? {} : { provider: d.target.provider }),
        ...(d.title === undefined ? {} : { title: d.title }),
        ...(d.status === undefined ? {} : { status: d.status }),
      },
    });
    if (typeof d.sourceThreadId === 'string' && d.sourceThreadId.length > 0) {
      upsertNode(nodes, { kind: 'thread', key: d.sourceThreadId, label: d.sourceThreadId });
      upsertEdge(edges, {
        kind: 'dispatch_from_thread',
        fromNodeId: nodeIdFor('thread', d.sourceThreadId),
        toNodeId: nodeIdFor('dispatch', d.bac_id),
        observedAt: d.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: d.bac_id },
        confidence: 'explicit',
      });
    }
    if (typeof d.workstreamId === 'string' && d.workstreamId.length > 0) {
      upsertNode(nodes, { kind: 'workstream', key: d.workstreamId, label: d.workstreamId });
      upsertEdge(edges, {
        kind: 'dispatch_in_workstream',
        fromNodeId: nodeIdFor('dispatch', d.bac_id),
        toNodeId: nodeIdFor('workstream', d.workstreamId),
        observedAt: d.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: d.bac_id },
        confidence: 'explicit',
      });
    }
    if (typeof d.mcpRequest?.codingSessionId === 'string') {
      upsertNode(nodes, { kind: 'coding-session', key: d.mcpRequest.codingSessionId, label: d.mcpRequest.codingSessionId });
      upsertEdge(edges, {
        kind: 'dispatch_requested_coding_session',
        fromNodeId: nodeIdFor('dispatch', d.bac_id),
        toNodeId: nodeIdFor('coding-session', d.mcpRequest.codingSessionId),
        observedAt: d.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: d.bac_id },
        confidence: 'explicit',
      });
    }
  }
  for (const q of input.queueItems) {
    upsertNode(nodes, {
      kind: 'queue-item',
      key: q.bac_id,
      label: q.title ?? q.bac_id,
      ...(q.createdAt === undefined ? {} : { observedAt: q.createdAt }),
      metadata: {
        ...(q.title === undefined ? {} : { title: q.title }),
        ...(q.status === undefined ? {} : { status: q.status }),
      },
    });
    // Resolve target via vault (covers cases where queue.created
    // wasn't in the events window).
    const tid = q.threadId ?? (q.scope === 'thread' ? q.targetId : undefined);
    const wid = q.workstreamId ?? (q.scope === 'workstream' ? q.targetId : undefined);
    if (typeof tid === 'string' && tid.length > 0) {
      upsertNode(nodes, { kind: 'thread', key: tid, label: tid });
      upsertEdge(edges, {
        kind: 'queue_targets_thread',
        fromNodeId: nodeIdFor('queue-item', q.bac_id),
        toNodeId: nodeIdFor('thread', tid),
        observedAt: q.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: q.bac_id },
        confidence: 'explicit',
      });
    }
    if (typeof wid === 'string' && wid.length > 0) {
      upsertNode(nodes, { kind: 'workstream', key: wid, label: wid });
      upsertEdge(edges, {
        kind: 'queue_targets_workstream',
        fromNodeId: nodeIdFor('queue-item', q.bac_id),
        toNodeId: nodeIdFor('workstream', wid),
        observedAt: q.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: q.bac_id },
        confidence: 'explicit',
      });
    }
  }
  for (const r of input.reminders) {
    const reminderId = r.bac_id ?? `${r.threadId}@${r.detectedAt ?? ''}`;
    trackObservedAt(r.detectedAt);
    upsertNode(nodes, {
      kind: 'inbound-reminder',
      key: reminderId,
      label: r.threadId,
      ...(r.detectedAt === undefined ? {} : { observedAt: r.detectedAt }),
      metadata: {
        ...(r.provider === undefined ? {} : { provider: r.provider }),
        ...(r.status === undefined ? {} : { status: r.status }),
        threadId: r.threadId,
      },
    });
    upsertNode(nodes, { kind: 'thread', key: r.threadId, label: r.threadId });
    upsertEdge(edges, {
      kind: 'reminder_for_thread',
      fromNodeId: nodeIdFor('inbound-reminder', reminderId),
      toNodeId: nodeIdFor('thread', r.threadId),
      observedAt: r.detectedAt ?? '',
      producedBy: { source: 'reminder-store', recordId: reminderId },
      confidence: 'explicit',
    });
  }
  for (const c of input.codingSessions) {
    const obs = c.lastSeenAt ?? c.attachedAt;
    trackObservedAt(obs);
    upsertNode(nodes, {
      kind: 'coding-session',
      key: c.bac_id,
      label: c.name ?? c.bac_id,
      ...(obs === undefined ? {} : { observedAt: obs }),
      metadata: {
        ...(c.status === undefined ? {} : { status: c.status }),
        ...(c.name === undefined ? {} : { title: c.name }),
        ...(c.cwd === undefined ? {} : { sourcePath: c.cwd }),
        ...(c.tool === undefined ? {} : { provider: c.tool }),
      },
    });
    if (typeof c.workstreamId === 'string' && c.workstreamId.length > 0) {
      upsertNode(nodes, { kind: 'workstream', key: c.workstreamId, label: c.workstreamId });
      upsertEdge(edges, {
        kind: 'coding_session_in_workstream',
        fromNodeId: nodeIdFor('coding-session', c.bac_id),
        toNodeId: nodeIdFor('workstream', c.workstreamId),
        observedAt: c.attachedAt ?? '',
        producedBy: { source: 'coding-session-store', recordId: c.bac_id },
        confidence: 'explicit',
      });
    }
  }

  // -------------------------------------------------------------------
  // Pass 3 — cross-cutting joins by canonical URL.
  //   timeline_same_url_as_thread:    timeline visit URL ↔ thread URL
  //   annotation_targets_thread:      annotation URL ↔ thread URL
  // -------------------------------------------------------------------
  // Build URL → thread id map. canonicalUrl preferred; fall back to
  // threadUrl (with fragment + trailing-slash normalization).
  const threadIdByUrl = new Map<string, string>();
  for (const t of input.threads) {
    const candidate = t.canonicalUrl ?? t.threadUrl;
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    threadIdByUrl.set(stripFragmentAndTrailingSlash(candidate), t.bac_id);
  }
  // Add timeline visit nodes; emit timeline_same_url_as_thread edges
  // when there's a thread match.
  for (const day of input.timelineDays) {
    trackObservedAt(day.updatedAt);
    for (const entry of day.entries) {
      const visitKey = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
      upsertNode(nodes, {
        kind: 'timeline-visit',
        key: visitKey,
        label: entry.title ?? visitKey,
        observedAt: entry.lastSeenAt,
        metadata: {
          url: entry.url,
          canonicalUrl: entry.canonicalUrl,
          title: entry.title,
          provider: entry.provider,
          visitCount: entry.visitCount,
        },
      });
      const threadId = threadIdByUrl.get(visitKey);
      if (threadId !== undefined) {
        upsertNode(nodes, { kind: 'thread', key: threadId, label: threadId });
        upsertEdge(edges, {
          kind: 'timeline_same_url_as_thread',
          fromNodeId: nodeIdFor('timeline-visit', visitKey),
          toNodeId: nodeIdFor('thread', threadId),
          observedAt: entry.lastSeenAt,
          producedBy: { source: 'timeline-projection' },
          confidence: 'deterministic',
        });
      }
    }
  }
  // Annotations → thread (URL match).
  for (const event of input.events) {
    if (event.type !== ANNOTATION_CREATED) continue;
    if (!isAnnotationCreatedPayload(event.payload)) continue;
    const url = event.payload.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    const threadId = threadIdByUrl.get(stripFragmentAndTrailingSlash(url));
    if (threadId === undefined) continue;
    upsertNode(nodes, { kind: 'thread', key: threadId, label: threadId });
    upsertEdge(edges, {
      kind: 'annotation_targets_thread',
      fromNodeId: nodeIdFor('annotation', event.payload.bac_id),
      toNodeId: nodeIdFor('thread', threadId),
      observedAt: new Date(event.acceptedAtMs).toISOString(),
      producedBy: {
        source: 'event-log',
        eventType: ANNOTATION_CREATED,
        dot: { replicaId: event.dot.replicaId, seq: event.dot.seq },
      },
      confidence: 'deterministic',
    });
  }

  // -------------------------------------------------------------------
  // Materialize: convert accumulators to deterministic snapshot.
  // -------------------------------------------------------------------
  const finalNodes: ConnectionNode[] = [];
  for (const node of nodes.values()) {
    finalNodes.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.firstSeenAt === undefined ? {} : { firstSeenAt: node.firstSeenAt }),
      ...(node.lastSeenAt === undefined ? {} : { lastSeenAt: node.lastSeenAt }),
      originReplicaIds: [...node.originReplicaIds].sort(),
      metadata: compactMetadata(node.metadata),
    });
  }

  const sortedNodes = sortAlphaById(finalNodes);
  const sortedEdges = sortAlphaById([...edges.values()]);

  const updatedAt =
    maxObservedAt.length > 0 ? maxObservedAt : '1970-01-01T00:00:00.000Z';

  return {
    scope: input.scope ?? {},
    nodes: sortedNodes,
    edges: sortedEdges,
    updatedAt,
    nodeCount: sortedNodes.length,
    edgeCount: sortedEdges.length,
  };
};

// ---------------------------------------------------------------------------
// On-disk store: rolling current.json + daily snapshots.
// ---------------------------------------------------------------------------

export interface ConnectionsStore {
  readonly putCurrent: (snapshot: ConnectionsSnapshot) => Promise<void>;
  readonly readCurrent: () => Promise<ConnectionsSnapshot | null>;
  readonly putDay: (date: string, snapshot: ConnectionsSnapshot) => Promise<void>;
  readonly readDay: (date: string) => Promise<ConnectionsSnapshot | null>;
  readonly listDays: () => Promise<readonly string[]>;
}

const SNAPSHOTS_DIR = 'snapshots';

export const createConnectionsStore = (vaultRoot: string): ConnectionsStore => {
  const root = join(vaultRoot, '_BAC', 'connections');
  const snapshotsDir = join(root, SNAPSHOTS_DIR);
  const currentPath = join(root, 'current.json');

  const writeAtomic = async (path: string, body: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${createRevision()}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  };

  const dayPath = (date: string): string => join(snapshotsDir, `${date}.json`);

  const putCurrent = async (snapshot: ConnectionsSnapshot): Promise<void> => {
    await writeAtomic(currentPath, JSON.stringify(snapshot, null, 2));
  };
  const readCurrent = async (): Promise<ConnectionsSnapshot | null> => {
    try {
      return JSON.parse(await readFile(currentPath, 'utf8')) as ConnectionsSnapshot;
    } catch {
      return null;
    }
  };

  const putDay = async (date: string, snapshot: ConnectionsSnapshot): Promise<void> => {
    await writeAtomic(dayPath(date), JSON.stringify(snapshot, null, 2));
  };
  const readDay = async (date: string): Promise<ConnectionsSnapshot | null> => {
    try {
      return JSON.parse(await readFile(dayPath(date), 'utf8')) as ConnectionsSnapshot;
    } catch {
      return null;
    }
  };

  const listDays = async (): Promise<readonly string[]> => {
    try {
      const entries = await readdir(snapshotsDir);
      return entries
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => name.replace(/\.json$/u, ''))
        .sort();
    } catch {
      return [];
    }
  };

  return { putCurrent, readCurrent, putDay, readDay, listDays };
};

// Subgraph helpers — used by the HTTP routes + MCP tools to crop a
// snapshot to a specific anchor or path.

export const subgraphForNode = (
  snapshot: ConnectionsSnapshot,
  nodeId: string,
  hops: number,
): ConnectionsSnapshot => {
  if (hops < 0) hops = 0;
  if (hops > 4) hops = 4;
  const visited = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  const allEdges = new Map(snapshot.edges.map((e) => [e.id, e] as const));
  const keptEdges = new Map<string, ConnectionEdge>();

  for (let h = 0; h < hops; h += 1) {
    const next = new Set<string>();
    for (const edge of allEdges.values()) {
      if (frontier.has(edge.fromNodeId) && !visited.has(edge.toNodeId)) {
        keptEdges.set(edge.id, edge);
        next.add(edge.toNodeId);
      }
      if (frontier.has(edge.toNodeId) && !visited.has(edge.fromNodeId)) {
        keptEdges.set(edge.id, edge);
        next.add(edge.fromNodeId);
      }
      // Edges between two already-visited nodes still belong in the
      // subgraph (closed-loop links).
      if (visited.has(edge.fromNodeId) && visited.has(edge.toNodeId)) {
        keptEdges.set(edge.id, edge);
      }
    }
    for (const id of next) visited.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }

  const allNodes = new Map(snapshot.nodes.map((n) => [n.id, n] as const));
  const keptNodes: ConnectionNode[] = [];
  for (const id of visited) {
    const n = allNodes.get(id);
    if (n !== undefined) keptNodes.push(n);
  }

  return {
    scope: { ...(snapshot.scope ?? {}), nodeId, hops },
    nodes: sortAlphaById(keptNodes),
    edges: sortAlphaById([...keptEdges.values()]),
    updatedAt: snapshot.updatedAt,
    nodeCount: keptNodes.length,
    edgeCount: keptEdges.size,
  };
};

export const findPath = (
  snapshot: ConnectionsSnapshot,
  fromNodeId: string,
  toNodeId: string,
  maxHops = 4,
): { found: true; nodes: readonly ConnectionNode[]; edges: readonly ConnectionEdge[] } | { found: false } => {
  if (fromNodeId === toNodeId) {
    const node = snapshot.nodes.find((n) => n.id === fromNodeId);
    if (node !== undefined) return { found: true, nodes: [node], edges: [] };
    return { found: false };
  }
  // BFS over undirected edges; return the first path found.
  const adjacency = new Map<string, ConnectionEdge[]>();
  for (const edge of snapshot.edges) {
    const a = adjacency.get(edge.fromNodeId) ?? [];
    a.push(edge);
    adjacency.set(edge.fromNodeId, a);
    const b = adjacency.get(edge.toNodeId) ?? [];
    b.push(edge);
    adjacency.set(edge.toNodeId, b);
  }
  const queue: { nodeId: string; pathNodes: string[]; pathEdges: ConnectionEdge[] }[] = [
    { nodeId: fromNodeId, pathNodes: [fromNodeId], pathEdges: [] },
  ];
  const visited = new Set<string>([fromNodeId]);
  while (queue.length > 0) {
    const { nodeId, pathNodes, pathEdges } = queue.shift()!;
    if (pathEdges.length >= maxHops) continue;
    for (const edge of adjacency.get(nodeId) ?? []) {
      const otherEnd = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      if (visited.has(otherEnd)) continue;
      visited.add(otherEnd);
      const nextNodes = [...pathNodes, otherEnd];
      const nextEdges = [...pathEdges, edge];
      if (otherEnd === toNodeId) {
        const nodeMap = new Map(snapshot.nodes.map((n) => [n.id, n] as const));
        return {
          found: true,
          nodes: nextNodes.map((id) => nodeMap.get(id)).filter((n): n is ConnectionNode => n !== undefined),
          edges: nextEdges,
        };
      }
      queue.push({ nodeId: otherEnd, pathNodes: nextNodes, pathEdges: nextEdges });
    }
  }
  return { found: false };
};
