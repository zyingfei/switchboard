// Attribution v1 — shadow emit orchestrator.
//
// The single entry point server.ts calls at the incumbent URL-resolve
// point. It is fully self-contained and DEFENSIVE: any failure (flag off,
// no/stale state artifact, missing title, scorer throw) results in a no-op.
// It returns void and touches nothing on the served response — the caller
// awaits it (or not) purely for the observability side effect.
//
// Reading the state artifact per resolve would add a 105KB disk read +
// JSON.parse to the serve path. Instead the WHOLE load is memoized on the
// artifact file's mtime: each resolve does a single cheap fs.stat, and only
// when the mtime differs from the memo do we read + parse + deserialize. The
// first resolve after a drain (which rewrites the file) reloads once;
// subsequent resolves return the in-memory state after nothing but a stat.
// The prior memo keyed on the parsed generatedAt, which still cost the read
// + parse every resolve — the mtime guard is what makes the hot path
// allocation-free.

import { stat } from 'node:fs/promises';

import {
  ATTRIBUTION_V1_ARTIFACT_MAX_AGE_MS,
  attributionV1ArtifactPath,
  deserializeAttributionV1State,
  isAttributionV1ArtifactFresh,
  readAttributionV1Artifact,
} from './artifact.js';
import { scoreVisit } from './scorer.js';
import type { AttributionV1State } from './state.js';
import {
  attributionV1ShadowEnabled,
  buildShadowRecord,
  recordShadowObservation,
} from './shadow.js';

interface MemoizedState {
  readonly vaultRoot: string;
  readonly mtimeMs: number;
  readonly generatedAt: string;
  readonly state: AttributionV1State;
}

let memoizedState: MemoizedState | null = null;

// Resolve the current v1 state for a vault, memoized on the artifact file's
// mtime. Returns null when there is no fresh artifact (shadow simply skips —
// it is observability, never a gate on serving). The stat is the only I/O on
// the hot path once the memo is warm; a missing/unreadable file falls
// through to null.
const loadStateForShadow = async (
  vaultRoot: string,
  now: () => Date,
): Promise<AttributionV1State | null> => {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(attributionV1ArtifactPath(vaultRoot))).mtimeMs;
  } catch {
    // No artifact yet (or unreadable) — nothing to shadow. Drop any stale
    // memo so we don't serve state for a file that has since vanished.
    memoizedState = null;
    return null;
  }
  if (
    memoizedState !== null &&
    memoizedState.vaultRoot === vaultRoot &&
    memoizedState.mtimeMs === mtimeMs
  ) {
    // Warm memo. Still enforce the age gate (cheap, no I/O) so a stalled
    // writer whose file stops changing cannot serve state past the max age —
    // preserving the pre-memo semantics without re-reading the file.
    if (
      now().getTime() - Date.parse(memoizedState.generatedAt) >
      ATTRIBUTION_V1_ARTIFACT_MAX_AGE_MS
    ) {
      return null;
    }
    return memoizedState.state;
  }
  // mtime changed (or first load / different vault): read + parse + hydrate.
  const artifact = await readAttributionV1Artifact(vaultRoot);
  if (artifact === null || !isAttributionV1ArtifactFresh(artifact, now)) {
    memoizedState = null;
    return null;
  }
  const state = deserializeAttributionV1State(artifact.state);
  memoizedState = { vaultRoot, mtimeMs, generatedAt: artifact.generatedAt, state };
  return state;
};

export const resetShadowStateMemoForTest = (): void => {
  memoizedState = null;
};

// Snapshot shape the title lookup needs — structurally typed so this module
// does not import the connections types. Matches both readCurrent() and the
// resolver-subgraph reads (both expose `.nodes`).
export type ShadowTitleSnapshot = Parameters<typeof titleForCanonicalUrl>[0];

export interface EmitAttributionV1ShadowInput {
  readonly vaultRoot: string;
  readonly canonicalUrl: string;
  // The connections snapshot the title is looked up from. The lookup is an
  // O(nodes) scan, so it runs LAZILY inside this function — only after the
  // flag + fresh-state gates pass — never on the serve path when the shadow
  // lane is off. Absent title ⇒ the scorer runs title-less (domain + recency
  // only); still recorded.
  readonly snapshot: ShadowTitleSnapshot;
  // The incumbent's decided workstream for this url, or null when it
  // abstained (inbox / no-suggestion). This is what agreement is measured
  // against.
  readonly incumbentTop: string | null;
  readonly now?: () => Date;
}

// Run the v1 scorer beside the incumbent and record the compact shadow
// comparison. Fully best-effort — never throws, never affects the caller's
// response. The caller may `void` this (fire-and-forget) or await it.
export const emitAttributionV1Shadow = async (
  input: EmitAttributionV1ShadowInput,
): Promise<void> => {
  try {
    if (!attributionV1ShadowEnabled()) return;
    const now = input.now ?? (() => new Date());
    const state = await loadStateForShadow(input.vaultRoot, now);
    if (state === null) return;
    // Only now — past the flag + fresh-state gates — pay for the O(nodes)
    // title scan, exactly once.
    const title = titleForCanonicalUrl(input.snapshot, input.canonicalUrl);
    const result = scoreVisit(
      { title: title ?? '', url: input.canonicalUrl },
      state,
    );
    const record = buildShadowRecord({
      url: input.canonicalUrl,
      ts: now().getTime(),
      incumbentTop: input.incumbentTop,
      v1: result,
    });
    recordShadowObservation(record);
  } catch {
    // Observability only — a shadow failure must never surface on the
    // serve path.
  }
};

// Extract the incumbent's decided workstream from a UrlResolutionResult-
// shaped object without importing the resolver types (keeps this module's
// import graph light and the coupling one-way). The incumbent decides a
// workstream only on suggest/auto-apply actions; inbox/other ⇒ null.
export const incumbentTopFromResolution = (resolution: {
  readonly decision: { readonly action: string; readonly workstreamId?: string };
}): string | null => {
  const { action, workstreamId } = resolution.decision;
  if (workstreamId === undefined || workstreamId.length === 0) return null;
  // Only treat an actual attribution decision as "the incumbent's top";
  // inbox is an abstention, so it maps to null (agreement with v1 abstain).
  if (action === 'inbox') return null;
  return workstreamId;
};

// Best-effort title for a canonical url from a connections-snapshot-shaped
// object (nodes with metadata.canonicalUrl/url/title and a label fallback).
// Structurally typed so this module does not import the connections types;
// undefined when no matching node carries a title.
export const titleForCanonicalUrl = (
  snapshot: {
    readonly nodes: readonly {
      readonly label?: string;
      readonly metadata?: { readonly canonicalUrl?: unknown; readonly url?: unknown; readonly title?: unknown };
    }[];
  },
  canonicalUrl: string,
): string | undefined => {
  let labelFallback: string | undefined;
  for (const node of snapshot.nodes) {
    const meta = node.metadata;
    if (meta === undefined) continue;
    const nodeUrl =
      typeof meta.canonicalUrl === 'string'
        ? meta.canonicalUrl
        : typeof meta.url === 'string'
          ? meta.url
          : undefined;
    if (nodeUrl !== canonicalUrl) continue;
    if (typeof meta.title === 'string' && meta.title.length > 0) return meta.title;
    if (labelFallback === undefined && typeof node.label === 'string' && node.label.length > 0) {
      labelFallback = node.label;
    }
  }
  return labelFallback;
};
