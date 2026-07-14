// Interleaving credit assignment (north-star §5 S1 / P11).
//
// Given an interleaved strip's per-item producer attribution and the logged
// actions on that impression, tally each producer's wins. The winner of an
// interleaving duel is the producer whose items the user engaged with more,
// summed over impressions — the arbiter that decides whether a candidate
// producer beats the incumbent.
//
// PURE MODULE — no I/O, no clock. Reads the LOGGED snapshots (the new S1
// propensity / servingConfig fields join here), never re-derives. It is the
// reader half of the interleaving scaffold; the draft half is teamDraft.ts.
// NOT wired into serving — S2 flips it behind a flag.

import {
  RECALL_ACTION,
  type RecallActionKind,
  type RecallActionPayload,
  isRecallActionPayload,
} from '../recall/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { InterleavedItem } from './teamDraft.js';

// Engagement counts as a WIN for the producer that placed the item. Same
// positive set as the reliability collector, kept independent so the two
// measurement surfaces can diverge if their label conventions ever do.
const WINNING_ACTIONS: ReadonlySet<RecallActionKind> = new Set<RecallActionKind>([
  'click',
  'open_new_tab',
  'snippet_promote',
  'flow_confirm',
  'move',
  'promote',
]);

/** An action targeting an item in an interleaved strip. Extracted from
 *  logged recall.action events (or supplied directly in a unit test). */
export interface InterleavedAction {
  readonly itemId: string;
  readonly actionKind: RecallActionKind;
  /** Inverse-propensity weight (P12) — de-biases the logged position prior
   *  when the strip used stochastic tie-breaking. Defaults to 1 (the
   *  team-draft coin is recorded via the seed, not per-item propensity, so
   *  deterministic serving keeps weight 1). */
  readonly weight?: number;
}

/** Per-producer credit tally over one or more impressions. */
export interface CreditTally {
  /** producer id → weighted count of winning engagements. */
  readonly wins: ReadonlyMap<string, number>;
  /** producer id → weighted count of items SHOWN (draft share). */
  readonly shown: ReadonlyMap<string, number>;
}

/**
 * Assign credit for one impression: for each winning action, look up which
 * producer drafted the acted-on item in the strip and tally the win.
 * Actions on items not in the strip are ignored (they belong to another
 * impression). Also tallies the draft share (items shown per producer) so a
 * caller can normalize wins by exposure.
 */
export const assignCredit = (
  strip: readonly InterleavedItem[],
  actions: readonly InterleavedAction[],
): CreditTally => {
  const producerByItem = new Map<string, string>();
  const shown = new Map<string, number>();
  for (const item of strip) {
    producerByItem.set(item.itemId, item.producer);
    shown.set(item.producer, (shown.get(item.producer) ?? 0) + 1);
  }
  const wins = new Map<string, number>();
  for (const action of actions) {
    if (!WINNING_ACTIONS.has(action.actionKind)) continue;
    const producer = producerByItem.get(action.itemId);
    if (producer === undefined) continue; // action for a different strip.
    wins.set(producer, (wins.get(producer) ?? 0) + (action.weight ?? 1));
  }
  return { wins, shown };
};

/** Extract the actions for one impression from the logged event stream,
 *  ready to feed assignCredit. `servedContextId` scopes to the impression
 *  the strip was served for. */
export const actionsForImpression = (
  servedContextId: string,
  events: readonly AcceptedEvent[],
): readonly InterleavedAction[] => {
  const out: InterleavedAction[] = [];
  for (const event of events) {
    if (event.type !== RECALL_ACTION || !isRecallActionPayload(event.payload)) continue;
    const action: RecallActionPayload = event.payload;
    if (action.servedContextId !== servedContextId) continue;
    out.push({ itemId: action.entityId, actionKind: action.actionKind });
  }
  return out;
};

/** Merge many per-impression tallies into a running duel score. */
export const mergeTallies = (tallies: readonly CreditTally[]): CreditTally => {
  const wins = new Map<string, number>();
  const shown = new Map<string, number>();
  for (const t of tallies) {
    for (const [producer, count] of t.wins) wins.set(producer, (wins.get(producer) ?? 0) + count);
    for (const [producer, count] of t.shown) {
      shown.set(producer, (shown.get(producer) ?? 0) + count);
    }
  }
  return { wins, shown };
};

/** The verdict of an interleaving duel between two producers. Positive
 *  `preference` favors the candidate; the standard interleaving score is
 *  (wins_candidate) / (wins_candidate + wins_incumbent) − 0.5, so 0 means a
 *  tie and the sign is the winner. Exposure-normalized alternative is
 *  reported too so an uneven draft share can't fake a win. */
export interface DuelVerdict {
  readonly incumbent: string;
  readonly candidate: string;
  readonly incumbentWins: number;
  readonly candidateWins: number;
  /** (candidateWins − incumbentWins) / (candidateWins + incumbentWins),
   *  in [-1, 1]. 0 when neither won or the wins are equal. */
  readonly preference: number;
}

export const duelVerdict = (
  tally: CreditTally,
  incumbent: string,
  candidate: string,
): DuelVerdict => {
  const incumbentWins = tally.wins.get(incumbent) ?? 0;
  const candidateWins = tally.wins.get(candidate) ?? 0;
  const total = incumbentWins + candidateWins;
  const preference = total > 0 ? (candidateWins - incumbentWins) / total : 0;
  return { incumbent, candidate, incumbentWins, candidateWins, preference };
};
