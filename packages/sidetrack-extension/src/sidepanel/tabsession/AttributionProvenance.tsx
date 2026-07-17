import { formatAnchorDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import type { ConnectionNode } from '../connections/types';
import {
  endorsementFor,
  hostFromUrl,
  isAggregatorHost,
  reasonChipsFor,
} from './suggestionEndorsement';
import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

const formatDate = (input: string): string => {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export interface AttributionProvenanceProps {
  readonly record: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // Live connections snapshot (id → node). When provided, anchor ids
  // resolve to the same human-friendly label used in the Connections
  // tab. When omitted, anchors degrade to kind-aware placeholders
  // ("Tab session", "(visit)") — never raw ids.
  readonly nodeById?: ReadonlyMap<string, ConnectionNode>;
  readonly displayCtx?: EntityDisplayCtx;
}

const EMPTY_NODE_BY_ID: ReadonlyMap<string, ConnectionNode> = new Map();
const DEFAULT_CTX: EntityDisplayCtx = {
  resolveWorkstreamPath: () => null,
  replicaAlias: () => 'Browser',
};

export function AttributionProvenance({
  record,
  suggestion,
  workstreams,
  nodeById,
  displayCtx,
}: AttributionProvenanceProps) {
  const ctx: EntityDisplayCtx = displayCtx ?? DEFAULT_CTX;
  const byId: ReadonlyMap<string, ConnectionNode> = nodeById ?? EMPTY_NODE_BY_ID;
  const attribution = record.currentAttribution;
  if (attribution !== undefined && attribution.workstreamId !== null) {
    const label =
      workstreams.find((workstream) => workstream.bac_id === attribution.workstreamId)?.path ??
      '(removed)';
    const source =
      attribution.source === 'user_asserted'
        ? 'you'
        : attribution.source === 'thread'
          ? 'thread move'
          : attribution.source === 'inferred'
            ? 'Sidetrack'
            : attribution.source;
    return (
      <span className="tab-session-provenance mono">
        Attributed by {source} on {formatDate(attribution.observedAt)} · {label}
      </span>
    );
  }
  // Surface the resolver's top fused candidate even when the policy did
  // NOT endorse it (action='inbox') — the user can still see the lean and
  // one-click confirm. But we must be honest about *whether the policy
  // endorsed it*: a suggest/auto-apply is a real "Suggested", an inbox
  // decision is a de-emphasised "Weak guess — not filed" so it never
  // masquerades as a settled or recommended pick (the live -0.62-margin
  // bug). endorsementFor() is the single source of truth.
  const endorsement = endorsementFor(suggestion);
  const topCandidate = suggestion?.fusedCandidates[0];
  if (endorsement.level !== 'none' && topCandidate !== undefined) {
    const targetPath =
      workstreams.find((workstream) => workstream.bac_id === endorsement.workstreamId)?.path ??
      '(removed)';
    const source = topCandidate.dominantSource;
    const seen = new Set<string>();
    const anchorLabels: string[] = [];
    for (const reason of topCandidate.reasons) {
      for (const anchor of reason.anchors) {
        const display = formatAnchorDisplay(anchor, byId, ctx);
        if (display.primary.startsWith('(')) continue;
        if (seen.has(display.primary)) continue;
        seen.add(display.primary);
        anchorLabels.push(display.primary);
        if (anchorLabels.length >= 3) break;
      }
      if (anchorLabels.length >= 3) break;
    }
    const chips = reasonChipsFor(topCandidate, record.pageEvidence);
    const isWeak = endorsement.level === 'weak-guess';
    // Honest phrasing: endorsed → "Suggested"; un-endorsed lean →
    // "Weak guess — filed to inbox" (policy action='inbox' means the item
    // went to the inbox, not a workstream — "not filed" wrongly implied it
    // went nowhere).
    const verb = isWeak ? 'Weak guess — filed to inbox' : 'Suggested';
    const margin = endorsement.margin;
    return (
      <span
        className={`tab-session-provenance mono${isWeak ? ' is-weak-guess' : ''}`}
        data-endorsement={endorsement.level}
      >
        <span className="tab-session-provenance-verb">{verb}</span>: {targetPath}
        {chips.length > 0 ? (
          <span className="tab-session-reason-chips">
            {chips.map((chip) => (
              <span
                key={chip.kind}
                className={`tab-session-reason-chip is-${chip.kind}`}
                title={chip.title}
              >
                {chip.label}
              </span>
            ))}
          </span>
        ) : null}
        <span className="tab-session-provenance-num">
          {source} · margin {margin.toFixed(2)}
        </span>
        {anchorLabels.length > 0 ? (
          <span className="tab-session-provenance-anchors">{anchorLabels.join(' · ')}</span>
        ) : null}
      </span>
    );
  }
  // No candidate at all. On a broad multi-topic platform (aggregator /
  // social / search) the structural similarity signal is deliberately
  // suppressed as an untrustworthy false-friend, so quiet here is expected
  // — say so instead of a bare "No attribution".
  const host = hostFromUrl(record.latestUrl);
  if (isAggregatorHost(host)) {
    return (
      <span
        className="tab-session-provenance mono is-quiet"
        data-endorsement="none"
        title="Broad multi-topic sites (news aggregators, social, search) share a URL skeleton across unrelated pages, so Sidetrack suppresses that similarity as a false-friend and waits for stronger evidence (graph proximity or page content)."
      >
        Broad site — waiting for stronger evidence
      </span>
    );
  }
  return (
    <span className="tab-session-provenance mono" data-endorsement="none">
      No attribution
    </span>
  );
}
