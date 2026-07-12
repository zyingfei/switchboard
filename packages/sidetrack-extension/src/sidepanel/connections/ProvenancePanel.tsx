import { useMemo, type ReactElement } from 'react';

import { FeedbackButtons, type FeedbackChoice } from '../feedback/FeedbackButtons';
import {
  formatNodeIdDisplay,
  isInternalIdLike,
  type EntityDisplayCtx,
} from '../entityDisplay/format';
import { feedbackRelationKindForEdgeKind } from './client';
import { EDGE_KINDS, FAMILIES, type EdgeFamily } from './edgeKinds';
import { CloseIcon } from './icons';
import { NodeChip } from './NodeChip';
import { ProducerPin } from './ProducerPin';
import type { ConnectionEdge, ConnectionNode } from './types';

// Right-rail provenance card — shown when the user clicks an edge.
// Edges get a from/to chip pair (NodeChip when the snapshot has the
// node, otherwise a softer text fallback formatted by
// formatNodeIdDisplay so raw ids never leak), a reason line, a
// producer pin when the edge carries a revisionId, and a feedback
// button group for edge kinds the user can confirm/reject.

const edgeConfidenceClass = (confidence: ConnectionEdge['confidence']): string =>
  confidence === 'inferred' ? 'confidence-inferred' : '';

const hasRevisionProducer = (edge: ConnectionEdge): boolean =>
  'revisionId' in edge.producedBy &&
  typeof edge.producedBy.revisionId === 'string' &&
  edge.producedBy.revisionId.length > 0;

export const ProvenanceCard = ({
  edge,
  allNodes,
  onFlowFeedback,
  onClose,
  onOpenUrl,
  ctx,
}: {
  readonly edge: ConnectionEdge;
  readonly allNodes: readonly ConnectionNode[];
  readonly onFlowFeedback: (edge: ConnectionEdge, choice: FeedbackChoice) => Promise<void>;
  readonly onClose: () => void;
  readonly onOpenUrl?: (url: string) => void;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const meta = EDGE_KINDS[edge.kind];
  const family: EdgeFamily = meta?.family ?? 'urlmatch';
  const fromNode = allNodes.find((n) => n.id === edge.fromNodeId);
  const toNode = allNodes.find((n) => n.id === edge.toNodeId);
  const nodeByIdLocal = useMemo(
    () => new Map(allNodes.map((node) => [node.id, node] as const)),
    [allNodes],
  );
  const reason = meta?.description ?? edge.kind;
  const supportsFlowFeedback = feedbackRelationKindForEdgeKind(edge.kind) !== null;
  return (
    <aside className="cx-prov" data-testid="edge-provenance" data-edge-id={edge.id}>
      <header className="cx-prov-head">
        <span className="cx-prov-kind">{edge.kind}</span>
        <span className="cx-stamp">{edge.confidence}</span>
        <span className="cx-grow" />
        <button type="button" onClick={onClose} aria-label="Close" className="cx-prov-close">
          {CloseIcon}
        </button>
      </header>
      <div className="cx-prov-pair">
        {fromNode !== undefined ? (
          <NodeChip
            node={fromNode}
            ctx={ctx}
            {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
          />
        ) : (
          <FallbackEndpoint nodeId={edge.fromNodeId} nodeById={nodeByIdLocal} ctx={ctx} />
        )}
        <div className="cx-prov-arrow">
          <span
            className={`cx-edge fam-${family} ${edgeConfidenceClass(edge.confidence)}`.trim()}
            aria-hidden
          >
            <span className="cx-edge-line" />
          </span>
          <span className="cx-prov-arrow-label">{meta?.label ?? edge.kind}</span>
        </div>
        {toNode !== undefined ? (
          <NodeChip
            node={toNode}
            ctx={ctx}
            {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
          />
        ) : (
          <FallbackEndpoint nodeId={edge.toNodeId} nodeById={nodeByIdLocal} ctx={ctx} />
        )}
      </div>
      <div className="cx-prov-reason">
        Reason: <code>{reason}</code>
      </div>
      {hasRevisionProducer(edge) ? (
        <ProducerPin producedBy={edge.producedBy} producerLabel={edge.kind} />
      ) : null}
      {supportsFlowFeedback ? (
        <div className="cx-prov-feedback">
          <FeedbackButtons
            key={edge.id}
            label="relation"
            onFeedback={async (choice) => {
              await onFlowFeedback(edge, choice);
              return { ok: true };
            }}
          />
        </div>
      ) : null}
      <dl className="cx-prov-rows">
        <ProvRow label="Edge kind" value={edge.kind} mono />
        <ProvRow label="Family" value={FAMILIES[family].label} />
        <ProvRow label="Source" value={edge.producedBy.source} />
        {edge.producedBy.eventType !== undefined ? (
          <ProvRow label="Event type" value={edge.producedBy.eventType} mono />
        ) : null}
        {edge.producedBy.dot !== undefined ? (
          <ProvRow
            label="Origin replica"
            value={`${ctx.replicaAlias(edge.producedBy.dot.replicaId)} · seq ${String(edge.producedBy.dot.seq)}`}
          />
        ) : null}
        {edge.producedBy.recordId !== undefined ? (
          <ProvRow
            label="Record id"
            value={edge.producedBy.recordId}
            mono
            testId="edge-record-id"
          />
        ) : null}
        <ProvRow label="Observed at" value={edge.observedAt} mono />
        <ProvRow label="Confidence" value={edge.confidence} />
      </dl>
    </aside>
  );
};

// Soft text fallback shown when the snapshot doesn't carry one side of
// an edge yet. Tooltip surfaces URL-ish detail when available; raw ids
// stay out of the user-visible hover text.
const FallbackEndpoint = ({
  nodeId,
  nodeById,
  ctx,
}: {
  readonly nodeId: string;
  readonly nodeById: ReadonlyMap<string, ConnectionNode>;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const display = formatNodeIdDisplay(nodeId, nodeById, ctx);
  const tip = display.tooltip;
  const safeTip = tip !== undefined && !isInternalIdLike(tip) ? tip : undefined;
  return (
    <span className="cx-dim" title={safeTip}>
      {display.primary}
    </span>
  );
};

const ProvRow = ({
  label,
  value,
  mono,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly testId?: string;
}): ReactElement => (
  <div className="cx-prov-row">
    <dt>{label}</dt>
    <dd className={mono === true ? 'mono' : ''} data-testid={testId}>
      {value}
    </dd>
  </div>
);

// Right-rail empty state — shown when no edge is selected and no
// "why" panel is open. When the user has an anchor, surfaces the
// anchor chip + a hint; otherwise prompts them to pick one.
export const ProvenanceEmpty = ({
  anchor,
  onOpenUrl,
  ctx,
}: {
  readonly anchor: ConnectionNode | null;
  readonly onOpenUrl?: (url: string) => void;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => (
  <div className="cx-prov-empty">
    <div className="cx-prov-empty-head">{anchor !== null ? 'Anchor summary' : 'No anchor'}</div>
    {anchor !== null ? (
      <NodeChip
        node={anchor}
        state="anchor"
        size="lg"
        ctx={ctx}
        {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
      />
    ) : null}
    <div className="cx-prov-empty-body">
      {anchor !== null
        ? 'Click an edge or neighbor row to see why each connection exists.'
        : 'Pick a node on the left to anchor the graph.'}
    </div>
  </div>
);
