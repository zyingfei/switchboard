import type { AcceptedEvent } from '../sync/causal.js';
import {
  isSelectionCopiedPayload,
  isSelectionPastedPayload,
  SELECTION_COPIED,
  SELECTION_PASTED,
  type SelectionCopiedPayload,
  type SelectionPastedPayload,
} from './events.js';

const MATCH_WINDOW_MS = 24 * 60 * 60 * 1_000;

interface CopyEvent {
  readonly event: AcceptedEvent<SelectionCopiedPayload>;
  readonly payload: SelectionCopiedPayload;
}

interface PasteEvent {
  readonly event: AcceptedEvent<SelectionPastedPayload>;
  readonly payload: SelectionPastedPayload;
}

export interface SnippetLineage {
  readonly snippetId: string;
  readonly copiedVisitId: string;
  readonly destinationKind: SelectionPastedPayload['destinationKind'];
  readonly destinationId: string;
  readonly selectionHash: string;
  readonly simhash64: string;
  readonly copiedAtMs: number;
  readonly pastedAtMs: number;
  readonly copyDot: { readonly replicaId: string; readonly seq: number };
  readonly pasteDot: { readonly replicaId: string; readonly seq: number };
  readonly match: 'exact' | 'fuzzy';
}

export interface SnippetProjection {
  readonly lineages: readonly SnippetLineage[];
}

const base64ToUint64 = (value: string): bigint => {
  const bytes = Buffer.from(value, 'base64');
  let out = 0n;
  for (const byte of bytes) out = (out << 8n) | BigInt(byte);
  return out;
};

export const hammingDistanceSimhash64 = (left: string, right: string): number => {
  let value = base64ToUint64(left) ^ base64ToUint64(right);
  let distance = 0;
  while (value !== 0n) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
};

const snippetIdFor = (selectionHash: string): string => `snippet_${selectionHash.slice(0, 24)}`;

const sortByTimeThenDot = <T extends { readonly event: AcceptedEvent }>(events: readonly T[]): T[] =>
  [...events].sort((a, b) => {
    if (a.event.acceptedAtMs !== b.event.acceptedAtMs) {
      return a.event.acceptedAtMs - b.event.acceptedAtMs;
    }
    if (a.event.dot.replicaId !== b.event.dot.replicaId) {
      return a.event.dot.replicaId < b.event.dot.replicaId ? -1 : 1;
    }
    return a.event.dot.seq - b.event.dot.seq;
  });

export const projectSnippetLineage = (events: readonly AcceptedEvent[]): SnippetProjection => {
  const copies: CopyEvent[] = [];
  const pastes: PasteEvent[] = [];
  for (const event of events) {
    if (event.type === SELECTION_COPIED && isSelectionCopiedPayload(event.payload)) {
      copies.push({ event: event as AcceptedEvent<SelectionCopiedPayload>, payload: event.payload });
    } else if (event.type === SELECTION_PASTED && isSelectionPastedPayload(event.payload)) {
      pastes.push({ event: event as AcceptedEvent<SelectionPastedPayload>, payload: event.payload });
    }
  }
  const orderedCopies = sortByTimeThenDot(copies);
  const lineages: SnippetLineage[] = [];

  for (const paste of sortByTimeThenDot(pastes)) {
    const candidates = orderedCopies.filter((copy) => {
      if (copy.event.acceptedAtMs > paste.event.acceptedAtMs) return false;
      return paste.event.acceptedAtMs - copy.event.acceptedAtMs <= MATCH_WINDOW_MS;
    });
    const exact = candidates.find(
      (copy) => copy.payload.selectionHash === paste.payload.selectionHash,
    );
    const fuzzy =
      exact ??
      candidates.find(
        (copy) =>
          hammingDistanceSimhash64(copy.payload.simhash64, paste.payload.simhash64) <= 3,
      );
    if (fuzzy === undefined) continue;
    lineages.push({
      snippetId: snippetIdFor(fuzzy.payload.selectionHash),
      copiedVisitId: fuzzy.payload.visitId,
      destinationKind: paste.payload.destinationKind,
      destinationId: paste.payload.destinationId,
      selectionHash: fuzzy.payload.selectionHash,
      simhash64: fuzzy.payload.simhash64,
      copiedAtMs: fuzzy.event.acceptedAtMs,
      pastedAtMs: paste.event.acceptedAtMs,
      copyDot: fuzzy.event.dot,
      pasteDot: paste.event.dot,
      match: exact === undefined ? 'fuzzy' : 'exact',
    });
  }

  return {
    lineages: lineages.sort((a, b) =>
      a.snippetId === b.snippetId
        ? a.destinationId.localeCompare(b.destinationId)
        : a.snippetId.localeCompare(b.snippetId),
    ),
  };
};
