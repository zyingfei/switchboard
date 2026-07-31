// Entity extraction — the parser half of the entity layer
// (docs/audits/2026-07-29-recommendation-graph-feature-review.md §G4/§E3).
//
// WHY THIS EXISTS. Every on-device gist the panel synthesizes ends with a
// `Key Entities: …` section — named by a 3B-class model, validated at ingest,
// persisted in ENTITY_CONTENT_ENRICHED. Until now that section was treated as
// OPAQUE PROSE: it went into the recall lexical index as characters and
// nothing else. The review's G4 is exactly that — "entities are generated and
// thrown away". This module is the cheapest possible recovery: a PURE parser
// from gist text to entity names. No new event, no model call, no side table.
//
// PURE + REPLAYABLE, deliberately. Because extraction is a function of gist
// text alone, the whole entity layer is a FOLD over enrichment events that
// already exist (entityIndex.ts). That buys three properties no additive event
// type could:
//   1. RETROACTIVE — every gist ever saved is covered the moment this ships.
//   2. RETRACTION-SAFE — the gist fold already honors retractions, so folding
//      downstream of it means a retracted gist's entities vanish for free.
//   3. RE-PARSEABLE — improving this parser improves history, not just new
//      gists. A persisted entity event would have frozen v1's mistakes.
//
// FORMAT REALITY. The models do not agree on a shape. Observed live:
//   a) "Key Entities: JFrog, OpenAI, zero-day security, cyber models,
//      software supply chain attacks."                        (inline commas)
//   b) "### Key Entities\n- People/Organizations: None explicitly mentioned.
//      \n- Technologies: Modern C++, inline functions, hazard pointers."
//                                                   (labelled bullet sublists)
//   c) the same section trailed by more prose on the same line.
//   d) "None explicitly mentioned." — the model saying honestly that it found
//      nothing, which must parse to EMPTY, not to an entity called "None".
// So the parser is written around the observed shapes, and every heuristic
// below names the shape it is there for.
//
// TYPED EMPTINESS (house rule). The result distinguishes "no Key Entities
// section in this gist" (`found: false`) from "the section exists and says
// there are none" (`found: true, entities: []`). Those are different facts
// about the vault and a caller that conflates them will report the wrong
// reason to the user.
//
// NO REGEX CATASTROPHES. Everything here is a linear scan: indexOf, split on a
// single character, charAt comparisons, and one `\s+` collapse (no nested
// quantifiers, no alternation with overlapping prefixes). A gist is bounded at
// ENRICHED_GIST_MAX_LENGTH (2000) chars by the event contract, but the parser
// does not rely on that bound for its complexity.

// ---- contract ---------------------------------------------------------

// The kind buckets a category LABEL can map to. Deliberately coarse: the
// label text is model-authored free prose ("People/Organizations",
// "Key technologies", "Open questions"), so a fine-grained taxonomy would be
// a fiction. Five buckets is what the observed labels actually support, and
// `kind` stays OPTIONAL — an inline comma list carries no category at all and
// must not be forced into one.
export const ENTITY_KINDS = ['people', 'org', 'tech', 'question', 'topic'] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface ExtractedEntity {
  // Display form: original casing, whitespace collapsed, markup and trailing
  // punctuation stripped. This is what a UI shows.
  readonly name: string;
  // Present only when the gist put the name under a category label we could
  // map. Absent is a real answer ("this came from an uncategorized list"),
  // never a placeholder.
  readonly kind?: EntityKind;
}

export interface ExtractedEntities {
  readonly entities: readonly ExtractedEntity[];
  // Was there a Key Entities section at all? See TYPED EMPTINESS above.
  readonly found: boolean;
  // How many CANDIDATES were rejected by the length bounds or the per-gist
  // cap. REPORT, NOT SILENT: a gist whose entity list was truncated is a fact
  // the index (and its route) can surface rather than pretending the model
  // named exactly what we kept. Placeholders ("None explicitly mentioned")
  // and duplicates are NOT counted — neither is a loss.
  readonly dropped: number;
}

// Length bounds. Below 2 chars a "name" is punctuation or an initial and
// cannot be looked up; above 80 it is a sentence the model glued into the
// list, and indexing sentences as entities is how an entity layer becomes
// noise. Both are also DoS bounds on what a runaway synthesis can push into
// the index.
export const ENTITY_NAME_MIN_LENGTH = 2;
export const ENTITY_NAME_MAX_LENGTH = 80;

// Per-gist cap. A well-behaved gist names 3–8 entities; 20 is generous
// headroom that still bounds the work a single degenerate gist (the
// repetition-loop class the retraction route exists for) can create in the
// index. Overflow is COUNTED in `dropped`, never dropped silently.
export const ENTITY_MAX_PER_GIST = 20;

// ---- normalization ----------------------------------------------------

// Characters stripped from the FRONT of a candidate: markdown emphasis, code
// ticks, quotes, opening brackets, list markers. Bounded loop (below) so a
// string of pure markup terminates.
const LEADING_TRIM = new Set([
  '*', '_', '`', '"', "'", '“', '‘', '(', '[', '{', '#', '-', '–', '—',
]);

// Characters stripped from the END: the same markup plus sentence
// punctuation. NOTE this also strips the '.' from "Inc." → "Inc" — accepted,
// because the alternative (keeping the '.' from every list-terminating
// "…attacks.") splits one entity into two spellings, which is worse.
const TRAILING_TRIM = new Set([
  '*', '_', '`', '"', "'", '”', '’', ')', ']', '}', '.', ',', ';', ':', '!',
]);

// Bounded so nested markup (`**"Name."**`) unwraps but a pathological input
// cannot spin. Four passes covers every shape observed.
const TRIM_PASSES = 4;

/**
 * Normalize a raw candidate to its DISPLAY form: collapse whitespace, strip
 * surrounding markup/quotes/brackets and trailing sentence punctuation.
 * Casing is PRESERVED — dedupe is case-insensitive but the user reads the
 * model's own capitalization ("JFrog", not "jfrog").
 */
export const normalizeEntityName = (raw: string): string => {
  // Single linear collapse: `\s+` has no nested quantifier, so this is O(n).
  let value = raw.replace(/\s+/gu, ' ').trim();
  for (let pass = 0; pass < TRIM_PASSES; pass += 1) {
    const before = value;
    let start = 0;
    while (start < value.length && LEADING_TRIM.has(value.charAt(start))) start += 1;
    let end = value.length;
    while (end > start && TRAILING_TRIM.has(value.charAt(end - 1))) end -= 1;
    value = value.slice(start, end).trim();
    if (value === before) break;
  }
  return value;
};

/**
 * The index key for a name: normalized, then lowercased. The SINGLE place
 * case-folding happens, so the fold, the route's exact-name lookup, and any
 * future consumer cannot drift on what "the same entity" means.
 */
export const entityKeyFor = (name: string): string => normalizeEntityName(name).toLowerCase();

// ---- placeholders ("the model found none") ----------------------------

// A model asked for entities and finding none says so IN THE LIST POSITION.
// Those strings are the honest answer, not entities: indexing "None
// explicitly mentioned" would create a hub entity meaning "nothing here".
// Matched on the NORMALIZED, lowercased candidate; prefixes rather than exact
// matches because the tails vary ("none", "none explicitly mentioned",
// "none identified in the text").
const isPlaceholderName = (lower: string): boolean => {
  if (lower === 'n/a' || lower === 'na' || lower === 'unknown' || lower === 'unspecified') {
    return true;
  }
  // 'not ' keeps the trailing space on purpose: it must match "not
  // applicable" without eating "Notion" or "Notebook LM".
  return (
    lower.startsWith('none') ||
    lower.startsWith('not ') ||
    lower.startsWith('no explicit') ||
    lower.startsWith('no specific') ||
    lower.startsWith('nothing')
  );
};

// ---- category label → kind -------------------------------------------

// Substring probes, matched by POSITION so a combined label resolves to the
// bucket that appears FIRST: "People/Organizations" → 'people' (people at 0,
// organi at 7). Substrings not words because the labels inflect freely
// ("Technology", "Technologies", "Key technologies used").
const KIND_PROBES: readonly (readonly [string, EntityKind])[] = [
  ['people', 'people'],
  ['person', 'people'],
  ['author', 'people'],
  ['individual', 'people'],
  ['organi', 'org'],
  ['compan', 'org'],
  ['institution', 'org'],
  ['vendor', 'org'],
  ['team', 'org'],
  ['tech', 'tech'],
  ['tool', 'tech'],
  ['librar', 'tech'],
  ['framework', 'tech'],
  ['language', 'tech'],
  ['product', 'tech'],
  ['software', 'tech'],
  ['protocol', 'tech'],
  ['algorithm', 'tech'],
  ['model', 'tech'],
  ['question', 'question'],
  ['unresolved', 'question'],
  ['topic', 'topic'],
  ['concept', 'topic'],
  ['theme', 'topic'],
  ['subject', 'topic'],
];

/**
 * Map a category label to a kind bucket, or undefined when the label is not
 * one we recognize. Undefined is LOAD-BEARING upstream: an unrecognized
 * prefix is probably not a category at all (see parseBulletBody).
 */
export const categoryKind = (label: string): EntityKind | undefined => {
  const lower = normalizeEntityName(label).toLowerCase();
  if (lower.length === 0) return undefined;
  let best: EntityKind | undefined;
  let bestAt = Number.MAX_SAFE_INTEGER;
  for (const [probe, kind] of KIND_PROBES) {
    const at = lower.indexOf(probe);
    if (at >= 0 && at < bestAt) {
      bestAt = at;
      best = kind;
    }
  }
  return best;
};

// ---- section location -------------------------------------------------

const KEY_MARKER = 'key entities';
const BARE_MARKER = 'entities';

// Leading markdown/list noise a header line may carry ("### ", "**", "- ").
const isHeaderNoise = (ch: string): boolean =>
  ch === '#' || ch === '*' || ch === '-' || ch === ' ' || ch === '\t' || ch === '•';

const leadingNoiseWidth = (line: string): number => {
  let i = 0;
  while (i < line.length && isHeaderNoise(line.charAt(i))) i += 1;
  return i;
};

interface MarkerSpan {
  readonly end: number;
}

// Find where the entity section's LABEL ends. 'key entities' is matched
// anywhere (shape (c): the section can sit mid-paragraph with prose on both
// sides). The bare 'Entities' fallback is LINE-ANCHORED and must be followed
// by a colon or the line end — the bare word appears constantly in ordinary
// summary prose ("the entities involved are…"), and matching that mid-
// sentence would comma-split a summary sentence into fake entities.
const findMarker = (gist: string): MarkerSpan | null => {
  const lower = gist.toLowerCase();
  const keyed = lower.indexOf(KEY_MARKER);
  if (keyed >= 0) return { end: keyed + KEY_MARKER.length };
  let lineStart = 0;
  for (;;) {
    const nl = lower.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? lower.length : nl;
    const line = lower.slice(lineStart, lineEnd);
    const offset = leadingNoiseWidth(line);
    if (line.startsWith(BARE_MARKER, offset)) {
      const rest = line.slice(offset + BARE_MARKER.length).trim();
      if (rest.length === 0 || rest.startsWith(':')) {
        return { end: lineStart + offset + BARE_MARKER.length };
      }
    }
    if (nl < 0) return null;
    lineStart = nl + 1;
  }
};

// Separators that may sit between the label and an inline list, on the SAME
// line as the label ("Key Entities:", "Key Entities —", "Key Entities**:").
// Applied only to the header line, so a '-' here is a separator and never a
// bullet.
const HEADER_SEPARATORS = new Set([':', '*', '_', '-', '–', '—', ' ', '\t', '#', '•']);

const stripHeaderSeparators = (line: string): string => {
  let i = 0;
  while (i < line.length && HEADER_SEPARATORS.has(line.charAt(i))) i += 1;
  return line.slice(i).trim();
};

// ---- list-line parsing ------------------------------------------------

const BULLET_CHARS = new Set(['-', '*', '•', '·', '+', '–', '—']);

// Strip a bullet marker, returning the body — or null when the line is not a
// bullet. Handles "- x", "* x", "• x", "1. x", "2) x".
const stripBullet = (line: string): string | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (BULLET_CHARS.has(trimmed.charAt(0))) return trimmed.slice(1).trim();
  let i = 0;
  while (i < trimmed.length && trimmed.charCodeAt(i) >= 48 && trimmed.charCodeAt(i) <= 57) i += 1;
  // ≤3 digits: an ordered list, not a year or a measurement.
  if (i > 0 && i <= 3) {
    const next = trimmed.charAt(i);
    if (next === '.' || next === ')') return trimmed.slice(i + 1).trim();
  }
  return null;
};

// A category label is short and comma-free. 40 chars covers the observed
// labels ("People/Organizations", "Key technologies mentioned") without
// swallowing a "Name: one-line gloss" body whole.
const CATEGORY_LABEL_MAX_LENGTH = 40;

/**
 * Where the entity list on a line ENDS. Shape (c): the model finishes the
 * list and keeps writing ("…supply chain attacks. The article argues …").
 * The cut is the first '.' FOLLOWED BY WHITESPACE and then more text — the
 * required whitespace is what keeps "Node.js" and "3.5-turbo" intact, since a
 * period inside a name is never followed by a space. Known limitation, stated
 * rather than hidden: "U.S. Congress" cuts at the second period.
 *
 * Only '.' terminates. '?' would truncate an "Open questions:" list at its
 * first entry, which is the exact bucket where trailing '?' is normal.
 */
const truncateAtSentenceBreak = (text: string): string => {
  let from = 0;
  for (;;) {
    const dot = text.indexOf('.', from);
    if (dot < 0 || dot + 1 >= text.length) return text;
    const next = text.charAt(dot + 1);
    if (next === ' ' || next === '\t') {
      // Something must follow the space, or this is just a terminal period
      // with trailing whitespace and there is nothing to cut off.
      if (text.slice(dot + 1).trim().length === 0) return text;
      return text.slice(0, dot);
    }
    from = dot + 1;
  }
};

// Split a list body into candidate segments. ',' and ';' only: both are used
// as list separators by the models, and splitting on a single character stays
// linear and predictable.
const splitSegments = (text: string): readonly string[] => {
  const out: string[] = [];
  for (const bySemi of text.split(';')) {
    for (const byComma of bySemi.split(',')) out.push(byComma);
  }
  return out;
};

// "A, B, and C" → the last segment arrives as "and C". Strip the conjunction
// (and the '&' spelling) before normalization so the entity is "C".
const stripLeadingConjunction = (segment: string): string => {
  const trimmed = segment.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('and ')) return trimmed.slice(4);
  if (lower.startsWith('& ')) return trimmed.slice(2);
  return trimmed;
};

// ---- the parser -------------------------------------------------------

interface Sink {
  add: (raw: string, kind: EntityKind | undefined) => void;
}

const addSegments = (text: string, kind: EntityKind | undefined, sink: Sink): void => {
  for (const segment of splitSegments(truncateAtSentenceBreak(text))) {
    sink.add(stripLeadingConjunction(segment), kind);
  }
};

// A bullet body is one of three shapes:
//   1. "Technologies: Modern C++, inline functions"  → known label ⇒ category
//   2. "Miscellaneous: a, b, c"                      → unknown label + commas
//      in the tail ⇒ still a list; the label is noise, so drop it and keep
//      the items uncategorized rather than indexing "Miscellaneous".
//   3. "JFrog: the artifact repository company"      → unknown label, no
//      commas ⇒ this is "Name: gloss"; the NAME is the entity and the gloss
//      is prose. Keeping the whole line would index a sentence.
// Shapes 2 and 3 are separated by the comma test, which is a heuristic and
// says so: a comma-containing gloss on an unknown label parses as a list.
const parseBulletBody = (body: string, sink: Sink): void => {
  const colon = body.indexOf(':');
  const label = colon > 0 && colon <= CATEGORY_LABEL_MAX_LENGTH ? body.slice(0, colon) : null;
  if (label === null || label.includes(',')) {
    addSegments(body, undefined, sink);
    return;
  }
  const tail = body.slice(colon + 1);
  const kind = categoryKind(label);
  if (kind !== undefined) {
    addSegments(tail, kind, sink);
    return;
  }
  if (tail.includes(',')) {
    addSegments(tail, undefined, sink);
    return;
  }
  sink.add(label, undefined);
};

/**
 * Parse a gist's `Key Entities` section into normalized, deduped entities.
 *
 * Pure: same text in, same result out, no I/O, no clock, no globals.
 */
export const extractEntities = (gist: string): ExtractedEntities => {
  const marker = findMarker(gist);
  if (marker === null) return { entities: [], found: false, dropped: 0 };

  const entities: ExtractedEntity[] = [];
  const seenAt = new Map<string, number>();
  let dropped = 0;

  const sink: Sink = {
    add: (raw, kind) => {
      const name = normalizeEntityName(raw);
      // Pure punctuation / empty segment ("A, , B"): nothing was lost, so it
      // is not counted as a drop.
      if (name.length === 0) return;
      const lower = name.toLowerCase();
      // Deliberate emptiness from the model — also not a drop.
      if (isPlaceholderName(lower)) return;
      if (name.length < ENTITY_NAME_MIN_LENGTH || name.length > ENTITY_NAME_MAX_LENGTH) {
        dropped += 1;
        return;
      }
      const at = seenAt.get(lower);
      if (at !== undefined) {
        // Case-insensitive dedupe, first spelling wins for display. A later
        // sighting UNDER A CATEGORY upgrades an earlier uncategorized one —
        // the categorized mention is strictly more information.
        const existing = entities[at];
        if (existing !== undefined && existing.kind === undefined && kind !== undefined) {
          entities[at] = { name: existing.name, kind };
        }
        return;
      }
      if (entities.length >= ENTITY_MAX_PER_GIST) {
        dropped += 1;
        return;
      }
      seenAt.set(lower, entities.length);
      entities.push(kind === undefined ? { name } : { name, kind });
    },
  };

  const rest = gist.slice(marker.end);
  const firstBreak = rest.indexOf('\n');
  const headerTail = stripHeaderSeparators(firstBreak < 0 ? rest : rest.slice(0, firstBreak));
  const followingLines = firstBreak < 0 ? [] : rest.slice(firstBreak + 1).split('\n');

  // Shape (a)/(c): the list rides on the header line itself.
  let started = false;
  if (headerTail.length > 0) {
    addSegments(headerTail, undefined, sink);
    started = true;
  }

  // Shape (b): bullet lines below the header. The section ENDS at the first
  // blank line, markdown heading, or non-bullet prose line AFTER content has
  // started — everything past that is the rest of the document, and reading
  // it as entities is how a parser turns a summary into noise. Blank lines
  // BEFORE any content are allowed ("### Key Entities\n\n- People: …").
  for (const line of followingLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (started) break;
      continue;
    }
    if (trimmed.startsWith('#')) break;
    const body = stripBullet(line);
    if (body !== null) {
      if (body.length > 0) parseBulletBody(body, sink);
      started = true;
      continue;
    }
    // A non-bullet line: only meaningful as the list itself when nothing has
    // been read yet ("Key Entities\nJFrog, OpenAI"). Otherwise it is the
    // prose that follows the section.
    if (started) break;
    addSegments(trimmed, undefined, sink);
    started = true;
  }

  return { entities, found: true, dropped };
};
