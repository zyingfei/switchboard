// Server-side anchor builder. Takes the assistant's turn body + the
// keyword the user (or agent) wants to highlight and returns a
// SerializedAnchor whose textQuote carries the term and 32-char
// prefix/suffix windows pulled from the turn body.
//
// Why on the server: the extension's findAnchor already handles
// markdown↔DOM divergence on the read side via the stripMarkdownFormatting
// fallback (anchors.ts:125), so the build side just needs to capture
// raw windows and let the live DOM do the rest. The benefit is that
// MCP-side agents stop doing offset arithmetic — they pass intent
// (`term`, optional `selectionHint`) and the companion handles the
// rest, mirroring the way the extension's per-turn composer already
// builds anchors from a Range.

import type { SerializedAnchor } from '../http/schemas.js';

const CONTEXT_CHARS = 32;
const TERM_MIN_LEN_WITHOUT_CONTEXT = 6;

export interface AnchorBuilderInput {
  readonly turnText: string;
  readonly term: string;
  // Optional disambiguator. Three accepted forms (in priority order):
  //   1. "ordinal:N" (1-based) — pick the Nth occurrence.
  //   2. Any other non-empty string — preceding-fragment match: pick
  //      the occurrence whose immediately-preceding window ends with
  //      this hint (case-insensitive, whitespace-collapsed).
  // When omitted, the FIRST occurrence is used.
  readonly selectionHint?: string;
}

export class AnchorBuilderError extends Error {
  constructor(
    readonly reason:
      | 'term-not-found'
      | 'tiny-term-without-context'
      | 'invalid-ordinal'
      | 'hint-no-match',
    message: string,
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

export const buildAnchorFromTerm = (input: AnchorBuilderInput): SerializedAnchor => {
  const trimmedTerm = input.term.trim();
  if (trimmedTerm.length === 0) {
    throw new AnchorBuilderError(
      'term-not-found',
      'Term is empty after trimming whitespace.',
    );
  }
  const occurrences = findAllOccurrences(input.turnText, trimmedTerm);
  if (occurrences.length === 0) {
    throw new AnchorBuilderError(
      'term-not-found',
      `Term '${trimmedTerm}' did not appear in the turn body.`,
    );
  }

  // Short terms ("AI", "ML") get rejected without a disambiguating hint;
  // 6-char minimum mirrors the MCP create_batch validator (annotationTools.ts).
  if (
    trimmedTerm.length < TERM_MIN_LEN_WITHOUT_CONTEXT &&
    (input.selectionHint === undefined || input.selectionHint.trim().length === 0)
  ) {
    throw new AnchorBuilderError(
      'tiny-term-without-context',
      `Term '${trimmedTerm}' is shorter than ${String(TERM_MIN_LEN_WITHOUT_CONTEXT)} chars; provide selectionHint to disambiguate.`,
    );
  }

  const chosen = ((): number => {
    const hint = input.selectionHint?.trim();
    if (hint === undefined || hint.length === 0) {
      return occurrences[0] ?? 0;
    }
    const ordinal = parseOrdinalHint(hint);
    if (ordinal !== null) {
      const picked = occurrences[ordinal - 1];
      if (picked === undefined) {
        throw new AnchorBuilderError(
          'invalid-ordinal',
          `selectionHint '${hint}' references occurrence ${String(ordinal)} but only ${String(occurrences.length)} exist.`,
        );
      }
      return picked;
    }
    // Preceding-fragment match. Compare the trailing window before
    // the term against the hint, normalised to a whitespace-collapsed
    // lowercase form. The window is bounded at 256 chars — long
    // enough to disambiguate even when the user pastes a sentence-
    // long preceding fragment.
    const normalisedHint = collapseWhitespace(hint);
    if (normalisedHint.length === 0) {
      return occurrences[0] ?? 0;
    }
    for (const offset of occurrences) {
      const before = collapseWhitespace(
        input.turnText.slice(Math.max(0, offset - 256), offset),
      );
      if (before.endsWith(normalisedHint) || before.includes(normalisedHint)) {
        return offset;
      }
    }
    throw new AnchorBuilderError(
      'hint-no-match',
      `selectionHint '${hint}' did not match any preceding context for term '${trimmedTerm}'.`,
    );
  })();

  const prefix = input.turnText.slice(Math.max(0, chosen - CONTEXT_CHARS), chosen);
  const suffix = input.turnText.slice(
    chosen + trimmedTerm.length,
    chosen + trimmedTerm.length + CONTEXT_CHARS,
  );

  return {
    textQuote: {
      exact: trimmedTerm,
      prefix,
      suffix,
    },
    // -1 sentinels mean "skip the textPosition fallback path in
    // findAnchor" — MCP-created anchors should re-anchor through
    // textQuote only, since the markdown-derived offsets won't
    // match the live DOM.
    textPosition: { start: -1, end: -1 },
    cssSelector: '',
  };
};
