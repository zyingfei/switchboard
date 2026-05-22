/**
 * Evidence-quality layer.
 *
 * Two responsibilities, both invariant-driven (no tuning knobs):
 *
 * (A) **Provenance.** Every token offered for embedding carries a
 *     `SemanticEvidenceSource`. URL-identity tokens that no other
 *     source corroborates are marked `UNCORROBORATED_URL_IDENTITY`
 *     and `packEvidence` excludes them — they cannot influence the
 *     embedding.
 *
 * (B) **Packing.** Tokens are emitted in evidence-strength order
 *     (TITLE_META → VISIBLE_CONTENT → CAPTURED_INTERACTION_TEXT →
 *     CORROBORATED_URL_SLUG) and packed until the embedder's input
 *     budget is reached. No fixed topK — the only cap is the model's
 *     actual context window (a fact, not a knob).
 *
 * What this layer DOESN'T do: pick winners by score, weight sources,
 * or cap same-host neighbours. Those are serve-time concerns handled
 * elsewhere (`expandSemanticRecallCandidates` anti-collapse).
 */

import { analyze } from './analyzer.js';
import { isStructuralIdentifier, parseUrlIdentity } from './identity.js';

/**
 * E5 (multilingual-e5-small) max sequence length, per the model
 * card: 512 tokens. Not tunable — it's the encoder's positional
 * embedding window. Exposed here so call sites that target a
 * different model (future) can override.
 */
export const E5_INPUT_TOKEN_BUDGET = 512;

export type SemanticEvidenceSource =
  /** Words from page text that the user actually saw (extractor terms/keyphrases/entities). */
  | 'VISIBLE_CONTENT'
  /** Captured chat turn body or other interaction text. Future hookup. */
  | 'CAPTURED_INTERACTION_TEXT'
  /** From `metadata.title` (the document's stated topic). */
  | 'TITLE_META'
  /** URL path segment whose lemma also appears in TITLE_META or VISIBLE_CONTENT. */
  | 'CORROBORATED_URL_SLUG'
  /** URL path segment with no corroboration. NEVER embedded. */
  | 'UNCORROBORATED_URL_IDENTITY';

/**
 * Hard eligibility: which sources may enter the embedding text. The
 * single exclusion is `UNCORROBORATED_URL_IDENTITY` — by design,
 * since the v2 pool's host-domination bug was precisely the case
 * where uncorroborated URL identity dominated the embedding.
 */
export const canEmbedAsSemantic = (source: SemanticEvidenceSource): boolean =>
  source !== 'UNCORROBORATED_URL_IDENTITY';

export interface EvidenceItem {
  /** Analyzer-normalized token (lower-case, post-split). */
  readonly token: string;
  readonly source: SemanticEvidenceSource;
  /** 0-based rank within `source` from the upstream extractor (stronger first). */
  readonly rank: number;
}

export interface EvidenceRecordInput {
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly content?: {
    readonly terms?: readonly { readonly term: string }[];
    readonly keyphrases?: readonly { readonly term: string }[];
    readonly entities?: readonly { readonly text: string }[];
  };
  /** Captured interaction text (chat turns). Optional for now; wired in a follow-up. */
  readonly capturedInteractionTexts?: readonly string[];
}

/**
 * Build the per-record evidence stream. Order = priority for the
 * packer:
 *   1. TITLE_META          — analyzer tokens from metadata.title
 *   2. VISIBLE_CONTENT     — extractor keyphrases → entities → terms
 *   3. CAPTURED_INTERACTION_TEXT — chat-turn bodies (future)
 *   4. CORROBORATED_URL_SLUG  — URL path segments whose tokens appear
 *                                in (1) or (2)
 *   5. UNCORROBORATED_URL_IDENTITY — URL path segments that don't
 *                                     appear elsewhere; emitted ONLY
 *                                     so the caller can audit
 *                                     provenance, never embedded
 *
 * Structural identifiers (UUIDs, hashes, timestamps, etc.) are
 * dropped from URL slugs BEFORE the corroboration step — they
 * cannot become CORROBORATED_URL_SLUG even if some adjacent text
 * coincidentally contains the hash.
 */
export const buildSemanticEvidence = (record: EvidenceRecordInput): readonly EvidenceItem[] => {
  const out: EvidenceItem[] = [];
  // Corroboration corpus: every analyzer-token from title + content +
  // captured-interaction-text. URL slugs are checked against this.
  const corpus = new Set<string>();

  const pushFromText = (
    text: string | undefined,
    source: SemanticEvidenceSource,
    baseRank: number,
  ): number => {
    if (text === undefined || text.length === 0) return baseRank;
    const tokens = analyze(text);
    let rank = baseRank;
    for (const t of tokens) {
      out.push({ token: t, source, rank });
      corpus.add(t);
      rank += 1;
    }
    return rank;
  };

  pushFromText(record.title, 'TITLE_META', 0);

  if (record.content !== undefined) {
    let rank = 0;
    for (const kp of record.content.keyphrases ?? []) {
      rank = pushFromText(kp.term, 'VISIBLE_CONTENT', rank);
    }
    for (const e of record.content.entities ?? []) {
      rank = pushFromText(e.text, 'VISIBLE_CONTENT', rank);
    }
    for (const t of record.content.terms ?? []) {
      rank = pushFromText(t.term, 'VISIBLE_CONTENT', rank);
    }
  }

  if (record.capturedInteractionTexts !== undefined) {
    let rank = 0;
    for (const txt of record.capturedInteractionTexts) {
      rank = pushFromText(txt, 'CAPTURED_INTERACTION_TEXT', rank);
    }
  }

  // URL slug — segment-by-segment. Drop structural identifiers up
  // front; for the rest, ask the corpus.
  const ident = parseUrlIdentity(record.canonicalUrl);
  if (ident !== null) {
    let urlRank = 0;
    for (const segment of ident.pathSegments) {
      if (isStructuralIdentifier(segment)) continue;
      // Analyzer-tokenize the segment to handle kebab/snake/dotted
      // identifiers consistently with the rest of the pipeline. Each
      // sub-token is classified independently.
      const subTokens = analyze(segment);
      for (const t of subTokens) {
        if (isStructuralIdentifier(t)) continue;
        const source: SemanticEvidenceSource = corpus.has(t)
          ? 'CORROBORATED_URL_SLUG'
          : 'UNCORROBORATED_URL_IDENTITY';
        out.push({ token: t, source, rank: urlRank });
        urlRank += 1;
      }
    }
  }

  return out;
};

/**
 * Approximate token cost for embedder budgeting. Cheap to compute,
 * exact-enough for the packer's purpose (we stop when we cross the
 * budget). E5 uses a subword (XLM-RoBERTa) tokenizer; English
 * averages ~4 chars/token, CJK averages ~1 char/token because each
 * CJK ideograph typically becomes its own subword.
 */
const approxEmbedderTokens = (text: string): number => {
  let count = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // CJK unified-ideographs + extension-A + Hiragana + Katakana.
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)) {
      count += 1;
    } else {
      count += 0.25; // ~4 chars per English subword
    }
  }
  return Math.ceil(count);
};

/**
 * Pack evidence items into a single embedder-input string, in stream
 * order. Drops `UNCORROBORATED_URL_IDENTITY` items entirely. Dedupes
 * by analyzer-normalized token (case-insensitive). Stops when the
 * next token would cross `budget`.
 *
 * Returns the assembled text. Provenance information stays in
 * `items` for the caller to attach to the vector record (invariant
 * 6).
 */
export const packEvidence = (
  items: readonly EvidenceItem[],
  budget: number = E5_INPUT_TOKEN_BUDGET,
): string => {
  const seen = new Set<string>();
  const kept: string[] = [];
  let running = 0;
  for (const item of items) {
    if (!canEmbedAsSemantic(item.source)) continue;
    if (seen.has(item.token)) continue;
    // 1 token of separator overhead between joined tokens.
    const tokenCost = approxEmbedderTokens(item.token) + 1;
    if (running + tokenCost > budget) break;
    seen.add(item.token);
    kept.push(item.token);
    running += tokenCost;
  }
  return kept.join(' ');
};

/**
 * Provenance summary for the embedded record (invariant 6 —
 * record-level audit). Caller writes this into the vector entry so
 * an operator can see WHY a vector ranks the way it does.
 */
export interface EvidenceProvenance {
  readonly bySource: Readonly<Record<SemanticEvidenceSource, number>>;
  /** True if at least one source other than uncorroborated-identity contributed. */
  readonly hasSemanticEvidence: boolean;
}

export const summarizeEvidence = (
  items: readonly EvidenceItem[],
): EvidenceProvenance => {
  const bySource: Record<SemanticEvidenceSource, number> = {
    VISIBLE_CONTENT: 0,
    CAPTURED_INTERACTION_TEXT: 0,
    TITLE_META: 0,
    CORROBORATED_URL_SLUG: 0,
    UNCORROBORATED_URL_IDENTITY: 0,
  };
  for (const item of items) bySource[item.source] += 1;
  const hasSemanticEvidence =
    bySource.TITLE_META > 0 ||
    bySource.VISIBLE_CONTENT > 0 ||
    bySource.CAPTURED_INTERACTION_TEXT > 0 ||
    bySource.CORROBORATED_URL_SLUG > 0;
  return { bySource, hasSemanticEvidence };
};
