// Team-draft interleaving scaffold (north-star §5 S1 / §4 pattern P11).
//
// Interleaving is the N=1 online arbiter: blend an INCUMBENT producer's
// ranked list and a CANDIDATE producer's ranked list into ONE served
// strip, then attribute clicks/actions back to the producer that placed
// each item. It has ~50× the A/B sensitivity of a split test and is the
// only honest judge for retrieval / candidate-set changes that replay
// structurally cannot evaluate (P10).
//
// This module is the PLUMBING ONLY. It is a PURE function of (incumbent,
// candidate, seed) — deterministic, no I/O, no clock, no globals — plus
// the credit-assignment reader that joins logged actions to producers. It
// is NOT wired into serving: the next stage (S2) flips it behind a flag.
// Team-draft (Radlinski, Kurup & Joachims, CIKM'08) is used, not
// balanced/draft interleaving, because it needs no click model and its
// per-item attribution is unambiguous — each item is "owned" by exactly
// the team that drafted it.

/** A ranked list from one producer, most-relevant first. Items are the
 *  stable identity used for credit assignment (e.g. entityId). */
export interface RankedList {
  /** Producer identity — 'incumbent' vs a candidate arm id. */
  readonly producer: string;
  /** Item ids in rank order (best first). Duplicates within a list are
   *  ignored after their first occurrence. */
  readonly items: readonly string[];
}

/** One position in the interleaved strip. */
export interface InterleavedItem {
  /** The item id shown at this position. */
  readonly itemId: string;
  /** The producer whose PICK placed this item — the credit owner. */
  readonly producer: string;
  /** 0-based position in the served strip. */
  readonly position: number;
}

export interface InterleaveResult {
  /** The blended strip, in served order. */
  readonly items: readonly InterleavedItem[];
  /** Which team won the first pick (the fairness coin flip's outcome).
   *  Recorded so credit assignment / audits can verify alternation. */
  readonly firstPick: string;
}

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG. mulberry32 — tiny, fast, well-distributed for a
// single fairness coin flip per draft. Seeded so the same (lists, seed)
// always yields the same strip: reproducible for replay, and stampable into
// the impression at serve time (the seed IS the propensity provenance).
// ---------------------------------------------------------------------------

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Team-draft interleave incumbent + candidate into one strip.
 *
 * Algorithm (per CIKM'08): while either team has an un-picked item, the
 * team that is currently "behind" (has contributed fewer items) picks its
 * next-best not-yet-shown item; ties in team size are broken by a fair coin
 * (the seeded PRNG) — this is the per-round randomization that makes the
 * assignment unbiased. Each drafted item is credited to the team that
 * picked it. Runs to exhaustion of both lists (deduping across teams: an
 * item already shown by one team is skipped by the other).
 *
 * `maxLength` caps the strip (defaults to unbounded). Deterministic given
 * (incumbent, candidate, seed).
 */
export const teamDraftInterleave = (
  incumbent: RankedList,
  candidate: RankedList,
  seed: number,
  maxLength = Number.POSITIVE_INFINITY,
): InterleaveResult => {
  const rng = mulberry32(seed);
  // Per-team cursors + dedup of already-drafted ids across BOTH teams.
  let iCursor = 0;
  let cCursor = 0;
  let iCount = 0;
  let cCount = 0;
  const shown = new Set<string>();
  const out: InterleavedItem[] = [];
  // Record the first-pick winner for audit/fairness verification.
  let firstPick: string | null = null;

  const nextUnshown = (list: readonly string[], cursor: number): number => {
    let idx = cursor;
    while (idx < list.length && shown.has(list[idx] as string)) idx += 1;
    return idx;
  };

  const hasMore = (): boolean =>
    nextUnshown(incumbent.items, iCursor) < incumbent.items.length ||
    nextUnshown(candidate.items, cCursor) < candidate.items.length;

  while (out.length < maxLength && hasMore()) {
    iCursor = nextUnshown(incumbent.items, iCursor);
    cCursor = nextUnshown(candidate.items, cCursor);
    const iHas = iCursor < incumbent.items.length;
    const cHas = cCursor < candidate.items.length;

    // Decide which team picks this round.
    let pickIncumbent: boolean;
    if (iHas && !cHas) pickIncumbent = true;
    else if (!iHas && cHas) pickIncumbent = false;
    else if (iCount < cCount) pickIncumbent = true;
    else if (cCount < iCount) pickIncumbent = false;
    else pickIncumbent = rng() < 0.5; // tie → fair coin.

    if (firstPick === null) {
      firstPick = pickIncumbent ? incumbent.producer : candidate.producer;
    }

    if (pickIncumbent) {
      const itemId = incumbent.items[iCursor] as string;
      shown.add(itemId);
      out.push({ itemId, producer: incumbent.producer, position: out.length });
      iCount += 1;
      iCursor += 1;
    } else {
      const itemId = candidate.items[cCursor] as string;
      shown.add(itemId);
      out.push({ itemId, producer: candidate.producer, position: out.length });
      cCount += 1;
      cCursor += 1;
    }
  }

  return { items: out, firstPick: firstPick ?? incumbent.producer };
};
