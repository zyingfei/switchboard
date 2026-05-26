// Unified visual-display layer for ConnectionNodes and resolver anchors.
//
// Hard invariants:
//   1. Display is not identity. The graph keeps raw ids; only visible
//      text changes. data-testid / action ids must continue to use the
//      raw node id.
//   2. Raw internal ids never appear in `primary` (visible text). They
//      may appear in `tooltip` only when the kind explicitly says so
//      (e.g. workstream tooltip is the bac_id for power users).
//   3. Companion metadata IMPROVES the display, but the helper must
//      render a human-safe label from kind + id alone when metadata is
//      missing. The frontend ships before any companion change.
//
// Reuses NODE_KIND_DISPLAY for kind names and formatRelative for time.

import { formatRelative } from '../../util/time';
import { NODE_KIND_DISPLAY } from '../connections/edgeKinds';
import type { ConnectionNode, ConnectionNodeKind } from '../connections/types';

export interface EntityDisplayCtx {
  // Resolve a workstream bac_id to its human path ("sideproject / sidetrack").
  // Returns null when the workstream is not in the user's local list — the
  // helper then falls back to metadata title or "Unknown workstream".
  readonly resolveWorkstreamPath: (bacId: string) => string | null;
  // Resolve a replica id to a human alias ("This browser" / "Browser 2"…).
  // Returns "Browser" while the alias map is hydrating from chrome.storage.
  readonly replicaAlias: (replicaId: string) => string;
  // Stage 5 polish — cross-node lookup for kinds whose title depends on
  // another node in the same snapshot. inbound-reminder needs the thread
  // it points at; future kinds may follow the same pattern. Optional so
  // surfaces without a snapshot (the Inbox path-resolver, for example)
  // still work — those kinds just won't get the enriched title.
  readonly nodeById?: ReadonlyMap<string, ConnectionNode>;
  // Local-only snippet text preview lookup. The companion stays hash-
  // only (rawTextStored:false on the payload), but the browser knows
  // what the user actually copied and caches the first 120 chars in
  // chrome.storage.local. The side panel passes a lookup keyed by
  // selectionHash (or its 12-char prefix) so the snippet card shows
  // the real text instead of a derived summary.
  readonly snippetPreview?: (hashOrPrefix: string | undefined) => string | undefined;
}

export interface EntityDisplay {
  readonly primary: string;
  readonly secondary?: string;
  readonly tooltip?: string;
  readonly kindBadge: string;
}

// Patterns we recognize as opaque internal ids — used to guard against
// node.label / anchor.label leaking through as visible text when the
// upstream couldn't produce a real title.
const ID_LIKE_PATTERNS: readonly RegExp[] = [
  /^tses_[A-Z0-9]/i,
  /^bac_[A-Za-z0-9]/i,
  /^visit-instance:/i,
  /^timeline-visit:/i,
  /^tab-session:/i,
  /^workstream:/i,
  /^thread:/i,
  /^dispatch:/i,
  /^replica:/i,
  /^topic:/i,
  /^snippet:/i,
  /^snippet_[a-z0-9]/i, // bare snippet id (no kind prefix)
  /^coding-session:/i,
  /^annotation:/i,
  /^queue-item:/i,
  /^inbound-reminder:/i,
  /^template:/i,
  // Crockford ULID short codes — 16-26 ALLCAPS+digit run with no spaces.
  /^[0-9A-Z]{16,26}$/,
];

export const isInternalIdLike = (value: string | undefined | null): boolean => {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (const pattern of ID_LIKE_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
};

export const hostOf = (input: string | undefined | null): string | undefined => {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  try {
    const host = new URL(input).host;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
};

const safeStr = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const metaStr = (
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  if (metadata === undefined) return undefined;
  for (const key of keys) {
    const value = safeStr(metadata[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const cleanLabel = (label: string | undefined | null): string | undefined => {
  const trimmed = safeStr(label);
  if (trimmed === undefined) return undefined;
  return isInternalIdLike(trimmed) ? undefined : trimmed;
};

// Tooltip values are rendered straight into `title=` attributes by
// NodeChip / NodeRow / PathFinder. The goal forbids raw internal ids
// from any visible text, including hover tooltips, so this helper
// drops any value that matches our id-like patterns. Callers can
// safely chain canonical-url / sourcePath etc. as the preferred
// tooltip, with `safeTooltip` as the final filter.
const safeTooltip = (value: string | undefined): string | undefined => {
  const trimmed = safeStr(value);
  if (trimmed === undefined) return undefined;
  return isInternalIdLike(trimmed) ? undefined : trimmed;
};

const KIND_FROM_PREFIX: ReadonlyMap<string, ConnectionNodeKind> = new Map([
  ['tab-session', 'tab-session'],
  ['visit-instance', 'visit-instance'],
  ['timeline-visit', 'timeline-visit'],
  ['workstream', 'workstream'],
  ['thread', 'thread'],
  ['dispatch', 'dispatch'],
  ['topic', 'topic'],
  ['replica', 'replica'],
  ['snippet', 'snippet'],
  ['coding-session', 'coding-session'],
  ['annotation', 'annotation'],
  ['queue-item', 'queue-item'],
  ['inbound-reminder', 'inbound-reminder'],
  ['template', 'template'],
]);

export const kindFromNodeId = (nodeId: string): ConnectionNodeKind | undefined => {
  const colon = nodeId.indexOf(':');
  if (colon === -1) return undefined;
  return KIND_FROM_PREFIX.get(nodeId.slice(0, colon));
};

const kindBadgeFor = (kind: ConnectionNodeKind | string | undefined): string => {
  if (kind === undefined) return 'Node';
  const map = NODE_KIND_DISPLAY as Record<string, { readonly label: string }>;
  return map[kind]?.label ?? kind;
};

const trimPrefix = (id: string, prefix: string): string =>
  id.startsWith(prefix) ? id.slice(prefix.length) : id;

const composeSecondary = (parts: readonly (string | undefined)[]): string | undefined => {
  const filtered = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return filtered.length > 0 ? filtered.join(' · ') : undefined;
};

const formatRelOrUndef = (iso: string | undefined): string | undefined => {
  if (iso === undefined) return undefined;
  try {
    return formatRelative(iso);
  } catch {
    return undefined;
  }
};

// Per-kind formatter dispatch. Every branch must produce a `primary` that
// is NEVER an opaque id and NEVER a raw URL; URLs surface as host only.
export const formatEntityDisplay = (node: ConnectionNode, ctx: EntityDisplayCtx): EntityDisplay => {
  const metadata = node.metadata;
  const kindBadge = kindBadgeFor(node.kind);

  switch (node.kind) {
    case 'workstream': {
      const bacId = trimPrefix(node.id, 'workstream:');
      const path = ctx.resolveWorkstreamPath(bacId);
      const title = metaStr(metadata, ['title']);
      const labelClean = cleanLabel(node.label);
      const primary = path ?? title ?? labelClean ?? 'Unknown workstream';
      // Only surface bacId as the tooltip when we fell through to the
      // 'Unknown workstream' placeholder — otherwise the path/title is
      // already the visible primary and the tooltip would either
      // duplicate it (bac_-prefixed bacId is filtered out by
      // safeTooltip) or leak a non-bac_-prefixed raw identifier.
      const tooltip =
        path === null && title === undefined && labelClean === undefined
          ? safeTooltip(bacId)
          : undefined;
      return { primary, kindBadge, tooltip };
    }
    case 'thread': {
      const title = metaStr(metadata, ['title']);
      const labelClean = cleanLabel(node.label);
      const provider = metaStr(metadata, ['provider']);
      const url = metaStr(metadata, ['url', 'canonicalUrl']);
      const primary =
        title ??
        labelClean ??
        (provider !== undefined ? `${provider} thread` : '(untitled thread)');
      const secondary = composeSecondary([provider, formatRelOrUndef(node.lastSeenAt)]);
      return { primary, secondary, kindBadge, tooltip: safeTooltip(url) };
    }
    case 'tab-session': {
      const latestTitle = metaStr(metadata, ['latestTitle']);
      const latestUrl = metaStr(metadata, ['latestUrl', 'canonicalUrl']);
      const host = hostOf(latestUrl);
      const labelClean = cleanLabel(node.label);
      const primary = latestTitle ?? labelClean ?? host ?? '(untracked tab)';
      const lastActivityAt = metaStr(metadata, ['lastActivityAt']) ?? node.lastSeenAt;
      const secondary = composeSecondary([host, formatRelOrUndef(lastActivityAt)]);
      return {
        primary,
        secondary,
        kindBadge,
        // Canonical URL when present; never the raw tab-session node id.
        tooltip: safeTooltip(latestUrl),
      };
    }
    case 'visit-instance': {
      // Stage 5 polish — disambiguate visit-instance from the
      // canonical timeline-visit (= "Page"). Both nodes carry the
      // same title; visit-instance secondary now folds in the
      // visit time so the user can tell two instances apart.
      const title = metaStr(metadata, ['title']);
      const canonicalUrl = metaStr(metadata, ['canonicalUrl', 'url']);
      const host = hostOf(canonicalUrl);
      const labelClean = cleanLabel(node.label);
      const primary = title ?? labelClean ?? host ?? '(visit)';
      const last = node.lastSeenAt ?? node.firstSeenAt;
      const secondary = composeSecondary([host, formatRelOrUndef(last)]);
      // Tooltip is canonical URL only — never the raw `visit-instance:tses_*:date:url` id.
      return { primary, secondary, kindBadge, tooltip: safeTooltip(canonicalUrl) };
    }
    case 'timeline-visit': {
      // The canonical aggregate. Secondary calls out the visitCount
      // so it's clear this row represents N visits (not just one).
      const title = metaStr(metadata, ['title']);
      const canonicalUrl = metaStr(metadata, ['canonicalUrl', 'url']);
      const host = hostOf(canonicalUrl);
      const labelClean = cleanLabel(node.label);
      const primary = title ?? labelClean ?? host ?? '(page)';
      const visitCountRaw = metadata['visitCount'];
      const visitCount =
        typeof visitCountRaw === 'number' && Number.isFinite(visitCountRaw)
          ? Math.max(0, Math.floor(visitCountRaw))
          : undefined;
      const visitsLabel =
        visitCount !== undefined
          ? `${String(visitCount)} visit${visitCount === 1 ? '' : 's'}`
          : undefined;
      const secondary = composeSecondary([host, visitsLabel]);
      return { primary, secondary, kindBadge, tooltip: safeTooltip(canonicalUrl) };
    }
    case 'dispatch': {
      const title = metaStr(metadata, ['title']);
      const provider = metaStr(metadata, ['provider']);
      const labelClean = cleanLabel(node.label);
      const primary =
        title ?? labelClean ?? (provider !== undefined ? `${provider} dispatch` : '(dispatch)');
      const secondary = composeSecondary([provider, formatRelOrUndef(node.lastSeenAt)]);
      return { primary, secondary, kindBadge, tooltip: undefined };
    }
    case 'coding-session': {
      const title = metaStr(metadata, ['title']);
      const sourcePath = metaStr(metadata, ['sourcePath']);
      const provider = metaStr(metadata, ['provider']);
      const labelClean = cleanLabel(node.label);
      const basename =
        sourcePath !== undefined ? sourcePath.split('/').filter(Boolean).pop() : undefined;
      const primary = title ?? labelClean ?? basename ?? '(coding session)';
      const secondary = composeSecondary([provider, formatRelOrUndef(node.lastSeenAt)]);
      return {
        primary,
        secondary,
        kindBadge,
        tooltip: safeTooltip(sourcePath),
      };
    }
    case 'topic': {
      let primary: string = '(topic cluster)';
      const titles = metadata['representativeTitles'];
      if (Array.isArray(titles) && titles.length > 0) {
        const first = safeStr(titles[0]);
        if (first !== undefined) primary = first;
      }
      if (primary === '(topic cluster)') {
        const labelClean = cleanLabel(node.label);
        if (labelClean !== undefined) primary = labelClean;
      }
      const memberCount = metadata['memberCount'];
      const secondary = typeof memberCount === 'number' ? `${memberCount} members` : undefined;
      return { primary, secondary, kindBadge, tooltip: undefined };
    }
    case 'replica': {
      // Alias is sufficient as the primary; the bare replica id is
      // not safe to expose even as a hover tooltip.
      const replicaId = trimPrefix(node.id, 'replica:');
      return { primary: ctx.replicaAlias(replicaId), kindBadge, tooltip: undefined };
    }
    case 'inbound-reminder': {
      // Stage 5 polish — every inbound-reminder previously rendered as
      // `(inbound-reminder)` because the snapshot's reminder nodes
      // carry only `threadId / provider / status`. Resolve the thread
      // via ctx.nodeById and surface "Reminder: <thread title>" so
      // users can tell 40 reminders apart at a glance.
      const threadId = metaStr(metadata, ['threadId']);
      const provider = metaStr(metadata, ['provider']);
      const status = metaStr(metadata, ['status']);
      const labelClean = cleanLabel(node.label);
      let primary: string;
      const threadNode =
        threadId === undefined
          ? undefined
          : (ctx.nodeById?.get(threadId) ?? ctx.nodeById?.get(`thread:${threadId}`));
      if (threadNode !== undefined) {
        const threadTitle = formatEntityDisplay(threadNode, ctx).primary;
        primary = `Reminder: ${threadTitle}`;
      } else if (labelClean !== undefined) {
        primary = labelClean;
      } else if (provider !== undefined) {
        primary = `Reminder · ${provider}`;
      } else {
        primary = 'Reminder';
      }
      const secondary = composeSecondary([status, formatRelOrUndef(node.lastSeenAt)]);
      return { primary, secondary, kindBadge, tooltip: undefined };
    }
    case 'snippet': {
      // Stage 5 polish — hash-only snippet lineage means the raw text
      // never leaves the user's device. Derive a useful primary from
      // the payload metrics that DO travel: contentKindHint +
      // charCount + lineCount. The legacy `match` field (= "exact" /
      // "fuzzy") is just the match-strategy and was confusing as a
      // title. If a local text preview is provided via context
      // (chrome.storage on this machine), use it.
      const localPreview =
        ctx.snippetPreview === undefined
          ? undefined
          : ctx.snippetPreview(metaStr(metadata, ['selectionHash', 'charHashPrefix']));
      if (localPreview !== undefined && localPreview.length > 0) {
        const truncated =
          localPreview.length > 80 ? `${localPreview.slice(0, 80).trimEnd()}…` : localPreview;
        const tooltip = safeTooltip(metaStr(metadata, ['canonicalUrl', 'url']));
        return { primary: truncated, kindBadge, tooltip };
      }
      const charCount =
        typeof metadata['charCount'] === 'number' ? (metadata['charCount'] as number) : undefined;
      const lineCount =
        typeof metadata['lineCount'] === 'number' ? (metadata['lineCount'] as number) : undefined;
      const contentKindHint = metaStr(metadata, ['contentKindHint']);
      const kindLabel = (() => {
        if (contentKindHint === 'code-block') return 'Code';
        if (contentKindHint === 'url') return 'URL';
        if (contentKindHint === 'mixed') return 'Mixed';
        if (contentKindHint === 'prose') return 'Prose';
        return undefined;
      })();
      const parts: string[] = [];
      if (kindLabel !== undefined) parts.push(kindLabel);
      if (lineCount !== undefined && lineCount > 1) {
        parts.push(`${String(lineCount)} lines`);
      }
      if (charCount !== undefined) parts.push(`${String(charCount)} chars`);
      const labelClean = cleanLabel(node.label);
      const primary = parts.length > 0 ? parts.join(' · ') : (labelClean ?? '(snippet)');
      const tooltip = safeTooltip(metaStr(metadata, ['canonicalUrl', 'url']));
      return { primary, kindBadge, tooltip };
    }
    case 'annotation':
    case 'queue-item':
    case 'template': {
      // Upstream snapshots sometimes stuff the bac_id into title when
      // the user-typed text is empty (see companion `snapshot.ts`
      // queue-item branch). Filter id-like values so they never reach
      // the visible primary.
      const title = cleanLabel(metaStr(metadata, ['title', 'text', 'note']));
      const labelClean = cleanLabel(node.label);
      const primary = title ?? labelClean ?? `(${kindBadge.toLowerCase()})`;
      return { primary, kindBadge, tooltip: undefined };
    }
    default: {
      const labelClean = cleanLabel(node.label);
      const primary = labelClean ?? `(${kindBadge.toLowerCase()})`;
      return { primary, kindBadge, tooltip: undefined };
    }
  }
};

// Format a bare node id when no live ConnectionNode is available
// (e.g. resolver anchors whose target isn't in the loaded snapshot).
// Always returns a safe primary; never leaks the raw id into visible text.
export const formatNodeIdDisplay = (
  nodeId: string,
  nodeById: ReadonlyMap<string, ConnectionNode>,
  ctx: EntityDisplayCtx,
): EntityDisplay => {
  const node = nodeById.get(nodeId);
  if (node !== undefined) return formatEntityDisplay(node, ctx);

  const kind = kindFromNodeId(nodeId);
  const kindBadge = kindBadgeFor(kind);

  if (kind === 'workstream') {
    const bacId = trimPrefix(nodeId, 'workstream:');
    const path = ctx.resolveWorkstreamPath(bacId);
    // Mirror the formatEntityDisplay rule: bacId only enters the
    // tooltip when the primary fell through to the placeholder.
    const tooltip = path === null ? safeTooltip(bacId) : undefined;
    return { primary: path ?? 'Unknown workstream', kindBadge, tooltip };
  }
  if (kind === 'replica') {
    const replicaId = trimPrefix(nodeId, 'replica:');
    return { primary: ctx.replicaAlias(replicaId), kindBadge, tooltip: undefined };
  }
  if (kind === 'tab-session') {
    return { primary: 'Tab session', kindBadge, tooltip: undefined };
  }
  if (kind === 'timeline-visit') {
    const url = trimPrefix(nodeId, 'timeline-visit:');
    const host = hostOf(url);
    return { primary: host ?? '(visit)', kindBadge, tooltip: safeTooltip(url) };
  }
  if (kind === 'visit-instance') {
    // visit-instance:tses_*:<iso>:<url>  — try to recover the URL from the tail.
    const tail = trimPrefix(nodeId, 'visit-instance:');
    const httpIdx = tail.indexOf(':http');
    if (httpIdx >= 0) {
      const url = tail.slice(httpIdx + 1);
      const host = hostOf(url);
      if (host !== undefined) return { primary: host, kindBadge, tooltip: safeTooltip(url) };
    }
    return { primary: '(visit)', kindBadge, tooltip: undefined };
  }

  // Lightweight fallbacks per kind.
  if (kind === 'thread') return { primary: '(thread)', kindBadge, tooltip: undefined };
  if (kind === 'dispatch') return { primary: '(dispatch)', kindBadge, tooltip: undefined };
  if (kind === 'topic') return { primary: '(topic)', kindBadge, tooltip: undefined };
  if (kind === 'snippet') return { primary: '(snippet)', kindBadge, tooltip: undefined };
  if (kind === 'coding-session')
    return { primary: '(coding session)', kindBadge, tooltip: undefined };
  if (kind === 'annotation') return { primary: '(note)', kindBadge, tooltip: undefined };
  if (kind === 'queue-item') return { primary: '(queue item)', kindBadge, tooltip: undefined };
  if (kind === 'inbound-reminder') return { primary: '(reminder)', kindBadge, tooltip: undefined };
  if (kind === 'template') return { primary: '(template)', kindBadge, tooltip: undefined };

  return { primary: 'Unknown node', kindBadge: kindBadge || 'Node', tooltip: undefined };
};

// Format a resolver anchor. Accepts either a bare node id (legacy wire
// format) or an enriched `{ id, kind?, label? }` object (Phase C). When
// the live snapshot has the node, prefer it; otherwise fall back to the
// resolver-supplied label IF it is human-readable (not id-like).
export interface AttributionAnchorLike {
  readonly id: string;
  readonly kind?: string;
  readonly label?: string;
}

export const formatAnchorDisplay = (
  anchor: string | AttributionAnchorLike,
  nodeById: ReadonlyMap<string, ConnectionNode>,
  ctx: EntityDisplayCtx,
): EntityDisplay => {
  const anchorId = typeof anchor === 'string' ? anchor : anchor.id;
  const enrichedLabel = typeof anchor === 'string' ? undefined : anchor.label;
  const display = formatNodeIdDisplay(anchorId, nodeById, ctx);

  const isLowSignal =
    display.primary === 'Unknown node' ||
    display.primary === 'Unknown workstream' ||
    display.primary === 'Tab session' ||
    display.primary.startsWith('(');
  if (isLowSignal) {
    const fromResolver = cleanLabel(enrichedLabel);
    if (fromResolver !== undefined) return { ...display, primary: fromResolver };
  }
  return display;
};

// Promote any old-shape string anchor to the enriched form so the rest
// of the codebase can rely on { id, kind, label } regardless of which
// resolver version produced it.
export const upgradeAnchor = (anchor: string | AttributionAnchorLike): AttributionAnchorLike => {
  if (typeof anchor !== 'string') return anchor;
  const kind = kindFromNodeId(anchor);
  return { id: anchor, ...(kind === undefined ? {} : { kind }) };
};
