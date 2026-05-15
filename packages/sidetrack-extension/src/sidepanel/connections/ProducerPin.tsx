import { useEffect, useState } from 'react';

import type { ConnectionEdgeProducedBy } from './types';

// S27 — Producer-pin UI.
//
// When a Class B/E edge carries a `revisionId`-bearing `producedBy` (i.e.,
// an inferred edge from a versioned producer like the LightGBM ranker, the
// topic clusterer, the engagement classifier, etc.), the user can:
//
//   1. SEE which producer + revision generated the edge.
//   2. PIN that revision so subsequent reads of this producer's outputs
//      surface the pinned revision instead of the latest.
//   3. UNPIN to revert to the active (latest) revision.
//
// Pinning is per-replica (lives in chrome.storage.local) and per-producer
// (one pin slot per `producedBy.source` namespace). Backed by the model
// registry's "active revision selection" policy in docs/architecture.md.
//
// The component is purely informational + interactive: it doesn't fetch
// the current producer's revision listing (that's a separate MCP tool /
// future UX); it only surfaces the active edge's revision and lets the
// user pin or unpin it.

const PIN_STORAGE_PREFIX = 'sidetrack.producerPin.';

interface PinReadable {
  readonly revisionId: string | null;
}

const readPin = async (source: string): Promise<PinReadable> => {
  try {
    const key = PIN_STORAGE_PREFIX + source;
    const got = await chrome.storage.local.get(key);
    const v = got[key];
    return { revisionId: typeof v === 'string' ? v : null };
  } catch {
    return { revisionId: null };
  }
};

const writePin = async (source: string, revisionId: string | null): Promise<void> => {
  try {
    const key = PIN_STORAGE_PREFIX + source;
    if (revisionId === null) {
      await chrome.storage.local.remove(key);
    } else {
      await chrome.storage.local.set({ [key]: revisionId });
    }
  } catch {
    // chrome.storage missing in test harness; pin is a best-effort surface.
  }
};

interface ProducerPinProps {
  readonly producedBy: ConnectionEdgeProducedBy;
  // Optional metadata for the producer surface (e.g., "ranker v3, learned from
  // 142 corrections"). When absent, the pin shows just the revisionId.
  readonly producerLabel?: string;
  readonly trainedFromCorrectionCount?: number;
}

export function ProducerPin({
  producedBy,
  producerLabel,
  trainedFromCorrectionCount,
}: ProducerPinProps) {
  // Only edges with revision-bearing producedBy can be pinned. Cross-replica
  // and event-log/vault sourced edges have no revisionId; render nothing.
  const revisionId =
    'revisionId' in producedBy && typeof producedBy.revisionId === 'string'
      ? producedBy.revisionId
      : null;
  const source = producedBy.source;

  const [pinnedRevisionId, setPinnedRevisionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const isPinnedToThis = pinnedRevisionId !== null && pinnedRevisionId === revisionId;
  const isPinnedToOther = pinnedRevisionId !== null && pinnedRevisionId !== revisionId;

  useEffect(() => {
    if (revisionId === null) return;
    let cancelled = false;
    void (async () => {
      const got = await readPin(source);
      if (!cancelled) setPinnedRevisionId(got.revisionId);
    })();
    return () => {
      cancelled = true;
    };
  }, [source, revisionId]);

  if (revisionId === null) return null;

  const labelHead =
    producerLabel ??
    (source === 'ranker'
      ? 'Closest-visit ranker'
      : source === 'visit-similarity'
        ? 'Visit similarity'
        : source === 'topic-clusterer'
          ? 'Topic clusterer'
          : source === 'engagement-classifier'
            ? 'Engagement classifier'
            : source === 'continuation-classifier'
              ? 'Continuation classifier'
              : source === 'snippet-lineage'
                ? 'Snippet lineage'
                : source);

  const corrections =
    typeof trainedFromCorrectionCount === 'number' && trainedFromCorrectionCount > 0
      ? ` (learned from ${String(trainedFromCorrectionCount)} corrections)`
      : '';

  const handlePin = async (): Promise<void> => {
    setBusy(true);
    try {
      await writePin(source, revisionId);
      setPinnedRevisionId(revisionId);
    } finally {
      setBusy(false);
    }
  };

  const handleUnpin = async (): Promise<void> => {
    setBusy(true);
    try {
      await writePin(source, null);
      setPinnedRevisionId(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cx-producer-pin" data-testid={`producer-pin-${source}`}>
      <span data-testid={`producer-pin-${source}-label`}>
        {labelHead}
        {corrections} ·{' '}
        <code className="mono cx-producer-pin-rev">rev {revisionId.slice(0, 8)}</code>
      </span>
      <span className="cx-producer-pin-spacer" />
      {isPinnedToThis ? (
        <button
          type="button"
          className="btn btn-ghost cx-producer-pin-button"
          disabled={busy}
          data-testid={`producer-pin-${source}-unpin`}
          onClick={() => {
            void handleUnpin();
          }}
        >
          Unpin
        </button>
      ) : (
        <>
          {isPinnedToOther ? (
            <span
              className="mono cx-producer-pin-other"
              data-testid={`producer-pin-${source}-other`}
            >
              other version pinned
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-primary cx-producer-pin-button"
            disabled={busy}
            data-testid={`producer-pin-${source}-pin`}
            onClick={() => {
              void handlePin();
            }}
          >
            Pin this version
          </button>
        </>
      )}
    </div>
  );
}
