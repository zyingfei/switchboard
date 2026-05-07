// Sync Contract v1 / Class E — versioned extraction revisions.
//
// The extraction layer sits between the immutable capture event log
// and downstream consumers (recall, context-pack, Obsidian, MCP,
// future summaries). Each `sourceUnitId` is a stable identity for
// one ChatGPT/Claude/Gemini turn (or future provider unit). Multiple
// extraction revisions can coexist for the same source unit;
// active-revision policy picks one canonical revision; recall is a
// CONSUMER of the active revision per source unit.
//
// Lane 2 lands the data model + extraction materializer + legacy
// capture wrap. Lane 2 follow-ups (manifest + planner + stored
// re-extract + capture.extraction.produced) are stages L2.S4..L2.S6.

// Stable per-turn identity. Provider-specific impls choose between
// the structured form (preferred when stable IDs are exposed) and
// the canonical-URL fallback. The plan's `SourceUnitId` template
// type collapses here to a plain string for storage.
export type SourceUnitId = string;

// Canonical id minter. Prefer structured `turn:<provider>:<convo>:<msg>`
// when both ids are present; fall back to URL+role+ordinal+snapshotHash.
export const sourceUnitIdFor = (input: {
  readonly provider: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly canonicalUrl?: string;
  readonly role?: string;
  readonly turnOrdinal?: number;
  readonly sourceSnapshotHash?: string;
}): SourceUnitId => {
  if (
    input.conversationId !== undefined &&
    input.messageId !== undefined &&
    input.conversationId.length > 0 &&
    input.messageId.length > 0
  ) {
    return `turn:${input.provider}:${input.conversationId}:${input.messageId}`;
  }
  const url = input.canonicalUrl ?? '';
  const role = input.role ?? 'unknown';
  const ordinal = input.turnOrdinal ?? 0;
  const snap = input.sourceSnapshotHash ?? '';
  return `turn:${input.provider}:${url}:${role}:${String(ordinal)}:${snap}`;
};

export interface ExtractionRevision {
  readonly extractionRevisionId: string;
  readonly sourceUnitId: SourceUnitId;
  readonly sourceBacId: string;
  readonly extractorId: string;
  readonly extractorVersion: string; // semver
  readonly extractionSchemaVersion: number;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly chunkerVersion: string;
  readonly createdAt: string;
  readonly producerReplicaId: string;
  // Producer-replica's accepted-event dot for this revision. Used
  // by causal supersede.
  readonly producerDot: { readonly replicaId: string; readonly seq: number };
  // The actual extraction output. Schema-versioned; consumers read
  // this to chunk + index. Lane 2 default schema embeds the turn
  // text + role + ordinal + heading metadata.
  readonly content: ExtractionRevisionContent;
}

export interface ExtractionRevisionContent {
  readonly turns: readonly {
    readonly ordinal: number;
    readonly role: 'user' | 'assistant' | 'system' | 'unknown';
    readonly text: string;
    readonly markdown?: string;
    readonly formattedText?: string;
    readonly modelName?: string;
  }[];
  readonly title?: string;
  readonly threadUrl?: string;
  readonly capturedAt: string;
}

// One file per source unit. The pointer split between "latest" and
// "indexed" is the durable signal recall reads to decide whether to
// source-replace its index.
export interface ExtractionSourceState {
  readonly sourceUnitId: SourceUnitId;
  readonly sourceBacId: string;
  readonly latestExtractionRevision: string;
  readonly indexedExtractionRevision?: string;
  readonly status: 'current' | 'stale';
  // Compact history for provenance + active-revision policy
  // input. Bounded to last N revisions to keep file size
  // reasonable. Each entry carries the full set of fields the
  // policy needs (schema version + producer dot) so we don't
  // have to load every revision file just to pick a winner.
  // Fields beyond `createdAt` are optional for forward-compat
  // with state files written before this expansion (treated as
  // schemaVersion=0 / no producer dot — policy falls back to
  // semver + capability-score tie-break).
  readonly history: readonly {
    readonly extractionRevisionId: string;
    readonly extractorId: string;
    readonly extractorVersion: string;
    readonly createdAt: string;
    readonly extractionSchemaVersion?: number;
    readonly producerDot?: { readonly replicaId: string; readonly seq: number };
  }[];
}
