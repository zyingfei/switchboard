// Server-side anchor builder. Takes the assistant's turn body + the
// keyword the user (or agent) wants to highlight and returns either
// a SerializedAnchor whose textQuote carries the term and 32-char
// prefix/suffix windows, or a structured failure the caller can
// surface to the model for self-correction.
//
// Why on the server: the extension's findAnchor already handles
// markdown↔DOM divergence on the read side via the
// stripMarkdownFormatting fallback (anchors.ts:125), so the build
// side just needs to capture raw windows and let the live DOM do
// the rest. The benefit is that MCP-side agents stop doing offset
// arithmetic — they pass intent (`term`, optional `selectionHint`)
// and the companion handles the rest, mirroring the way the
// extension's per-turn composer already builds anchors from a
// Range.
//
// Result shape (post-PR-92-review): the build returns a tagged
// union instead of throwing. Each failure carries a reason the
// MCP create_batch tool maps to a per-item retry-able status, plus
// suggestedSelectionHints / occurrenceCount that let the agent
// retry without prompt-side procedural knowledge.

import type { SerializedAnchor } from '../http/schemas.js';

const CONTEXT_CHARS = 32;
const DEFAULT_SHORT_TERM_MIN = 6;
const HINT_PRECEDING_WINDOW = 256;
// Hint suggestion budget: enough to disambiguate up to 5 occurrences
// without flooding the response. Beyond 5, the agent should rely on
// `ordinal:N`.
const MAX_SUGGESTED_HINTS = 5;
// How much preceding text to include in each suggested hint. ~32
// chars is enough to be unambiguous but short enough to keep the
// response compact.
const SUGGESTED_HINT_LEN = 32;

export type RepeatedTermPolicy = 'first' | 'require_hint';

export interface AnchorPolicy {
  // What to do when a term has multiple occurrences and no
  // selectionHint is provided.
  //   - 'first'         — pick the first occurrence (legacy default).
  //   - 'require_hint'  — return ambiguous_term_requires_selection_hint
  //                       so the caller can retry with a hint.
  // Default: 'require_hint' (the safer behavior; the legacy 'first'
  // default routinely picked the wrong WebGPU/leaf/node/key).
  readonly repeatedTerm?: RepeatedTermPolicy;
  // Minimum term length when no selectionHint is supplied. Below
  // this, the builder returns short_term_requires_selection_hint
  // even if the term has only one occurrence.
  readonly shortTermMinLength?: number;
}

export type AnchorBuilderFailureReason =
  | 'term_not_found'
  | 'short_term_requires_selection_hint'
  | 'ambiguous_term_requires_selection_hint'
  | 'invalid_ordinal'
  | 'selection_hint_no_match';

export interface AnchorBuilderInput {
  readonly turnText: string;
  readonly term: string;
  readonly selectionHint?: string;
  readonly policy?: AnchorPolicy;
}

export interface AnchorBuilderOk {
  readonly ok: true;
  readonly anchor: SerializedAnchor;
  readonly occurrenceCount: number;
}

export interface AnchorBuilderFailure {
  readonly ok: false;
  readonly reason: AnchorBuilderFailureReason;
  readonly message: string;
  readonly occurrenceCount: number;
  readonly suggestedSelectionHints?: readonly string[];
}

export type AnchorBuilderResult = AnchorBuilderOk | AnchorBuilderFailure;

// Legacy throw-based wrapper. The companion's annotation route still
// catches AnchorBuilderError to map to HTTP 400; new callers should
// prefer the result-returning `buildAnchorFromTerm` directly.
export class AnchorBuilderError extends Error {
  constructor(
    readonly reason: AnchorBuilderFailureReason,
    message: string,
    readonly occurrenceCount = 0,
    readonly suggestedSelectionHints?: readonly string[],
  ) {
    super(message);
    this.name = 'AnchorBuilderError';
  }
}

const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();

const findAllOccurrences = (haystack: string, needle: string): readonly number[] => {
  const indices: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) {
      break;
    }
    indices.push(index);
    from = index + 1;
  }
  return indices;
};

const parseOrdinalHint = (hint: string): number | null => {
  const match = /^ordinal:(\d+)$/iu.exec(hint.trim());
  if (match === null) {
    return null;
  }
  const ordinal = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(ordinal) && ordinal >= 1 ? ordinal : null;
};

// Build a list of preceding-fragment hints the caller can retry
// with. Each hint is a short snippet of unique context preceding
// one occurrence. Trim aggressively so the agent can paste it back
// in `selectionHint` without parsing.
const buildSuggestedHints = (
  turnText: string,
  occurrences: readonly number[],
): readonly string[] => {
  const out: string[] = [];
  for (let index = 0; index < occurrences.length && out.length < MAX_SUGGESTED_HINTS; index += 1) {
    const offset = occurrences[index] ?? 0;
    out.push(`ordinal:${String(index + 1)}`);
    if (offset > 0) {
      const fragment = turnText
        .slice(Math.max(0, offset - SUGGESTED_HINT_LEN), offset)
        .replace(/\s+/g, ' ')
        .trim();
      if (fragment.length > 0 && !out.includes(fragment)) {
        out.push(fragment);
      }
    }
  }
  return out;
};

export const buildAnchorFromTerm = (input: AnchorBuilderInput): AnchorBuilderResult => {
  const policy: Required<AnchorPolicy> = {
    repeatedTerm: input.policy?.repeatedTerm ?? 'require_hint',
    shortTermMinLength: input.policy?.shortTermMinLength ?? DEFAULT_SHORT_TERM_MIN,
  };
  const trimmedTerm = input.term.trim();
  if (trimmedTerm.length === 0) {
    return {
      ok: false,
      reason: 'term_not_found',
      message: 'Term is empty after trimming whitespace.',
      occurrenceCount: 0,
    };
  }
  const occurrences = findAllOccurrences(input.turnText, trimmedTerm);
  if (occurrences.length === 0) {
    return {
      ok: false,
      reason: 'term_not_found',
      message: `Term '${trimmedTerm}' did not appear in the turn body.`,
      occurrenceCount: 0,
    };
  }

  const hint = input.selectionHint?.trim();
  const hasHint = hint !== undefined && hint.length > 0;

  if (trimmedTerm.length < policy.shortTermMinLength && !hasHint) {
    return {
      ok: false,
      reason: 'short_term_requires_selection_hint',
      message: `Term '${trimmedTerm}' is shorter than ${String(policy.shortTermMinLength)} chars; provide selectionHint to disambiguate.`,
      occurrenceCount: occurrences.length,
      suggestedSelectionHints: buildSuggestedHints(input.turnText, occurrences),
    };
  }

  if (occurrences.length > 1 && !hasHint && policy.repeatedTerm === 'require_hint') {
    return {
      ok: false,
      reason: 'ambiguous_term_requires_selection_hint',
      message: `Term '${trimmedTerm}' appears ${String(occurrences.length)} times; provide selectionHint (ordinal:N or a preceding-text fragment) to disambiguate.`,
      occurrenceCount: occurrences.length,
      suggestedSelectionHints: buildSuggestedHints(input.turnText, occurrences),
    };
  }

  let chosen: number;
  if (!hasHint) {
    chosen = occurrences[0] ?? 0;
  } else {
    const ordinal = parseOrdinalHint(hint);
    if (ordinal !== null) {
      const picked = occurrences[ordinal - 1];
      if (picked === undefined) {
        return {
          ok: false,
          reason: 'invalid_ordinal',
          message: `selectionHint '${hint}' references occurrence ${String(ordinal)} but only ${String(occurrences.length)} exist.`,
          occurrenceCount: occurrences.length,
        };
      }
      chosen = picked;
    } else {
      const normalisedHint = collapseWhitespace(hint);
      let matchedOffset = -1;
      if (normalisedHint.length > 0) {
        for (const offset of occurrences) {
          const before = collapseWhitespace(
            input.turnText.slice(Math.max(0, offset - HINT_PRECEDING_WINDOW), offset),
          );
          if (before.endsWith(normalisedHint) || before.includes(normalisedHint)) {
            matchedOffset = offset;
            break;
          }
        }
      }
      if (matchedOffset < 0) {
        return {
          ok: false,
          reason: 'selection_hint_no_match',
          message: `selectionHint '${hint}' did not match any preceding context for term '${trimmedTerm}'.`,
          occurrenceCount: occurrences.length,
          suggestedSelectionHints: buildSuggestedHints(input.turnText, occurrences),
        };
      }
      chosen = matchedOffset;
    }
  }

  const prefix = input.turnText.slice(Math.max(0, chosen - CONTEXT_CHARS), chosen);
  const suffix = input.turnText.slice(
    chosen + trimmedTerm.length,
    chosen + trimmedTerm.length + CONTEXT_CHARS,
  );

  return {
    ok: true,
    anchor: {
      textQuote: {
        exact: trimmedTerm,
        prefix,
        suffix,
      },
      textPosition: { start: -1, end: -1 },
      cssSelector: '',
    },
    occurrenceCount: occurrences.length,
  };
};
