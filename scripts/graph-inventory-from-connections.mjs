#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_SNAPSHOT_PATH = join(
  homedir(),
  '.sidetrack-vault',
  '_BAC',
  'connections',
  'current.json',
);

const snapshotPath = resolve(
  process.argv[2] ?? process.env.SIDETRACK_CONNECTIONS_SNAPSHOT ?? DEFAULT_SNAPSHOT_PATH,
);

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (record, key, fallback) => {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
};

const REVISION_PRODUCERS = new Set([
  'visit-similarity',
  'topic-clusterer',
  'engagement-classifier',
  'snippet-lineage',
  'continuation-classifier',
  'ranker',
]);

const WORKSTREAM_EDGE_KINDS = new Set([
  'thread_in_workstream',
  'dispatch_in_workstream',
  'coding_session_in_workstream',
  'visit_in_workstream',
  'visit_instance_in_workstream',
  'tab_session_in_workstream',
  'topic_in_workstream',
]);

const TOPIC_EDGE_KINDS = new Set(['visit_in_topic', 'topic_in_workstream', 'topic.lineage']);

const increment = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

const edgeEndpoint = (edge, key) => {
  const value = edge[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const producerKeyFor = (edge) => {
  const producedBy = isRecord(edge.producedBy) ? edge.producedBy : {};
  const eventType = producedBy.eventType;
  if (typeof eventType === 'string' && eventType.length > 0) return `event:${eventType}`;
  const source = stringField(producedBy, 'source', '(missing producer)');
  if (REVISION_PRODUCERS.has(source)) return `revision:${source}`;
  return `source:${source}`;
};

const sortedEntries = (counts) =>
  [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

const printCounts = (title, counts) => {
  console.log(`\n${title}`);
  if (counts.size === 0) {
    console.log('  (none)');
    return;
  }
  for (const [key, count] of sortedEntries(counts)) {
    console.log(`  ${key}: ${count}`);
  }
};

const readSnapshot = () => {
  const parsed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('snapshot root is not a JSON object');
  }
  const nodes = parsed.nodes;
  const edges = parsed.edges;
  if (!Array.isArray(nodes)) throw new Error('snapshot.nodes is not an array');
  if (!Array.isArray(edges)) throw new Error('snapshot.edges is not an array');
  return { snapshot: parsed, nodes, edges };
};

try {
  const { snapshot, nodes, edges } = readSnapshot();
  const nodesByKind = new Map();
  const edgesByKind = new Map();
  const edgesByConfidence = new Map();
  const edgesByProducer = new Map();
  const edgeKindByProducer = new Map();
  const edgesByMetadataPresence = new Map();
  const edgesByFamily = new Map();
  const candidatePathFamilyCounts = new Map();
  const nodeIds = new Set();
  let missingEndpointCount = 0;
  let classEInferredEdgeCount = 0;
  let workstreamEdgeCount = 0;
  let topicEdgeCount = 0;
  let closestVisitEdgeCount = 0;

  for (const node of nodes) {
    if (!isRecord(node)) {
      increment(nodesByKind, '(malformed node)');
      continue;
    }
    increment(nodesByKind, stringField(node, 'kind', '(missing kind)'));
    const id = stringField(node, 'id', '');
    if (id.length > 0) nodeIds.add(id);
  }

  for (const edge of edges) {
    if (!isRecord(edge)) {
      increment(edgesByKind, '(malformed edge)');
      continue;
    }
    const kind = stringField(edge, 'kind', '(missing kind)');
    const confidence = stringField(edge, 'confidence', '(missing confidence)');
    const producer = producerKeyFor(edge);
    const producedBy = isRecord(edge.producedBy) ? edge.producedBy : {};
    const producedBySource = stringField(producedBy, 'source', '(missing producer)');
    const family = stringField(edge, 'family', '(missing family)');
    const fromNodeId = edgeEndpoint(edge, 'fromNodeId');
    const toNodeId = edgeEndpoint(edge, 'toNodeId');
    const hasMissingEndpoint =
      fromNodeId === undefined ||
      toNodeId === undefined ||
      !nodeIds.has(fromNodeId) ||
      !nodeIds.has(toNodeId);

    increment(edgesByKind, kind);
    increment(edgesByConfidence, confidence);
    increment(edgesByProducer, producer);
    increment(edgeKindByProducer, `${producer} / ${kind}`);
    increment(edgesByMetadataPresence, isRecord(edge.metadata) ? 'with metadata' : 'without metadata');
    increment(edgesByFamily, family);
    if (!hasMissingEndpoint) increment(candidatePathFamilyCounts, family);
    if (hasMissingEndpoint) missingEndpointCount += 1;
    if (confidence === 'inferred' && REVISION_PRODUCERS.has(producedBySource)) {
      classEInferredEdgeCount += 1;
    }
    if (WORKSTREAM_EDGE_KINDS.has(kind)) workstreamEdgeCount += 1;
    if (TOPIC_EDGE_KINDS.has(kind)) topicEdgeCount += 1;
    if (kind === 'closest_visit') closestVisitEdgeCount += 1;
  }

  console.log(`Snapshot: ${snapshotPath}`);
  console.log(`updatedAt: ${stringField(snapshot, 'updatedAt', '(missing)')}`);
  console.log(`snapshotRevision: ${stringField(snapshot, 'snapshotRevision', '(missing)')}`);
  console.log(`nodes: ${nodes.length}`);
  console.log(`edges: ${edges.length}`);
  console.log(`missingEndpointCount: ${missingEndpointCount}`);
  console.log(`classEInferredEdgeCount: ${classEInferredEdgeCount}`);
  console.log(`workstreamEdgeCount: ${workstreamEdgeCount}`);
  console.log(`topicEdgeCount: ${topicEdgeCount}`);
  console.log(`closestVisitEdgeCount: ${closestVisitEdgeCount}`);
  printCounts('Nodes by kind', nodesByKind);
  printCounts('Edges by kind', edgesByKind);
  printCounts('Edges by confidence', edgesByConfidence);
  printCounts('Edges by producedBy.eventType / revision producer', edgesByProducer);
  printCounts('Edges by producer/kind', edgeKindByProducer);
  printCounts('Edges by family', edgesByFamily);
  printCounts('Edges by metadata presence', edgesByMetadataPresence);
  printCounts('Candidate path family counts (valid endpoints only)', candidatePathFamilyCounts);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to inventory ${snapshotPath}: ${message}`);
  process.exitCode = 1;
}
