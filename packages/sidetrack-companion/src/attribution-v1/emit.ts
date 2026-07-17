// Attribution v1 — shadow emit orchestrator.
//
// The single entry point server.ts calls at the incumbent URL-resolve
// point. It is fully self-contained and DEFENSIVE: any failure (flag off,
// no/stale state artifact, missing title, scorer throw) results in a no-op.
// It returns void and touches nothing on the served response — the caller
// awaits it (or not) purely for the observability side effect.
//
// Reading the state artifact per resolve would add a disk read to the serve
// path. Instead the deserialized state is memoized per (vaultRoot, artifact
// generatedAt): the first resolve after a drain reads + deserializes once,
// subsequent resolves reuse the in-memory state until the next drain writes
// a fresher artifact. The read itself is a tiny JSON file; the memo keeps
// the hot path allocation-free.

import {
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
  readonly generatedAt: string;
  readonly state: AttributionV1State;
}

let memoizedState: MemoizedState | null = null;

// Resolve the current v1 state for a vault, memoized on the artifact's
// generatedAt. Returns null when there is no fresh artifact (shadow simply
// skips — it is observability, never a gate on serving).
const loadStateForShadow = async (
  vaultRoot: string,
  now: () => Date,
): Promise<AttributionV1State | null> => {
  const artifact = await readAttributionV1Artifact(vaultRoot);
  if (artifact === null || !isAttributionV1ArtifactFresh(artifact, now)) return null;
  if (
    memoizedState !== null &&
    memoizedState.vaultRoot === vaultRoot &&
    memoizedState.generatedAt === artifact.generatedAt
  ) {
    return memoizedState.state;
  }
  const state = deserializeAttributionV1State(artifact.state);
  memoizedState = { vaultRoot, generatedAt: artifact.generatedAt, state };
  return state;
};

export const resetShadowStateMemoForTest = (): void => {
  memoizedState = null;
};

export interface EmitAttributionV1ShadowInput {
  readonly vaultRoot: string;
  readonly canonicalUrl: string;
  // Best-effort visit title (from the snapshot node / timeline). Absent ⇒
  // the scorer runs title-less (domain + recency only); still recorded.
  readonly title?: string;
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
    const result = scoreVisit(
      { title: input.title ?? '', url: input.canonicalUrl },
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
