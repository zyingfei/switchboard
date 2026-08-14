// COMPARATIVE GENERATION — judge quality by A/B on the same document, not by vibes.
//
// The Health eval already scored ONE engine's output. That answers "is this
// output degenerate?" but not the question a human actually has: "which of the
// models I can run writes the better summary of THIS page?" One output with a
// groundedness of 0.43 means nothing on its own; next to another engine's 0.61
// on the same input it means something.
//
// So: take one document, run EVERY currently-available engine on it, and render
// the outputs side by side with their deterministic scores and latency.
//
// FOUR RULES, all of them load-bearing:
//
//   1. OBSERVE-ONLY. Nothing here writes. No enrichment POST, no storage, no
//      companion call — this module takes engines and a string and returns rows.
//      The whole point is a judgment surface, and a judgment surface that
//      silently persists its winner is a serving change wearing a lab coat.
//   2. THE WINNER MUST HAVE PASSED. It is the highest groundedness AMONG
//      OUTPUTS THAT VALIDATE. A rejected output is never crowned, however well
//      it scores — the write path would have thrown it away, so calling it the
//      best is a lie. When nothing validates the headline says so outright.
//   3. CAPABILITY ROUTING IS RESPECTED. Chrome's built-in model does not
//      support Chinese (language.ts). For zh / mixed content its row reads
//      "not eligible (language)" and the model is NEVER asked — running it to
//      watch it fail would be theatre, and would also poison the comparison
//      with a guaranteed loser.
//   4. THE MATCHUP IS STATED. Each row declares its model's parameters and
//      quantization, and when the rows are NOT the same parameter class the
//      result carries an explicit caveat. Chrome's built-in model is ~3.25B
//      4-bit; our default local model is 1B q4. A comparison that silently
//      pits 1B against 3.25B and reports a "winner" is measuring model size and
//      calling it engine quality.
//
// Pure orchestration over injected engines — unit-testable with stubs, no React.

import { prepareInput, type EngineLimits } from './engineLimits';
import { GIST_GENERATION } from './generationOptions';
import { detectContentLanguage, nanoCanServe, type ContentLanguage } from './language';
import { describeIdentity, type EngineIdentity, type EngineKind } from './modelRegistry';
import { scoreGeneration, type GenerationScores } from './scoreGeneration';
import { GIST_PROMPT_PREFIX } from './titleSynthesis';
import { validateGeneration, type GenerationRejectionReason } from './validateGeneration';
import { engineIdentityOf, engineLimitsOf, type GenerationEngine } from './engine';

/** How one engine's attempt ended. Every value renders as its own sentence. */
export type CompareStatus =
  | 'ok'
  /** Generated text that the write-path validator would refuse. */
  | 'rejected'
  /** The model replied SKIP or nothing at all. */
  | 'abstained'
  /** The engine threw (model error, network, auth…). */
  | 'error'
  /** Never asked: this engine cannot serve this content language. */
  | 'not-eligible-language';

export interface CompareRow {
  readonly kind: EngineKind;
  /** "Chrome built-in" / "local" / "remote". */
  readonly label: string;
  /** "Chrome built-in · ~3.25B · 4-bit" — the declared matchup line. */
  readonly matchup: string;
  readonly identity: EngineIdentity;
  readonly limits: EngineLimits;
  readonly status: CompareStatus;
  /** The raw generated text, kept even when REJECTED so a human can see why. */
  readonly text: string | null;
  readonly rejection: GenerationRejectionReason | null;
  readonly scores: GenerationScores | null;
  readonly ms: number;
  readonly error: string | null;
  /** Input accounting, so a short answer on a long page is explicable. */
  readonly inputChars: number;
  readonly processedChars: number;
  readonly inputReduced: boolean;
  /** True when this engine sends the document off the device. */
  readonly sendsTextOffDevice: boolean;
}

export interface CompareOutcome {
  readonly rows: readonly CompareRow[];
  /** The engine whose PASSING output scored highest on groundedness. */
  readonly winnerKind: EngineKind | null;
  /** One honest line: the winner, or "no engine produced a usable summary". */
  readonly headline: string;
  /** Present when the rows that ran are not the same parameter class. */
  readonly sizeCaveat: string | null;
  readonly language: ContentLanguage;
}

/** Deterministic tie-break order, local-first — the same order routing uses. */
export const COMPARE_ENGINE_ORDER: readonly EngineKind[] = ['nano', 'apple', 'webgpu', 'remote'];

/** The exact headline when nothing validated. Asserted verbatim in the tests. */
export const NO_USABLE_SUMMARY = 'no engine produced a usable summary';

const orderIndex = (kind: EngineKind): number => {
  const i = COMPARE_ENGINE_ORDER.indexOf(kind);
  return i === -1 ? COMPARE_ENGINE_ORDER.length : i;
};

/** A model reply that means "I have nothing" rather than "here is my answer". */
const isAbstention = (raw: string): boolean => {
  const t = raw.trim();
  return t.length === 0 || t === 'SKIP';
};

/**
 * Pick the winner: highest groundedness among rows that PASSED validation.
 * Ties break by the fixed engine order, so the same inputs always name the same
 * winner. Null when no row passed — never crown a rejected output.
 */
export const pickWinner = (rows: readonly CompareRow[]): CompareRow | null => {
  const passing = rows.filter((r) => r.status === 'ok' && r.scores !== null);
  if (passing.length === 0) return null;
  return passing.reduce((best, row) => {
    const a = row.scores?.groundedness ?? 0;
    const b = best.scores?.groundedness ?? 0;
    if (a > b) return row;
    if (a < b) return best;
    return orderIndex(row.kind) < orderIndex(best.kind) ? row : best;
  });
};

/**
 * The size caveat, built from the DECLARED parameter counts of the rows that
 * actually ran. Null when every runner is the same parameter class (or when
 * fewer than two ran, or when a provider does not disclose its size — in which
 * case the caveat still fires, because "unknown vs 1B" is not a fair fight
 * either).
 */
export const sizeCaveatFor = (rows: readonly CompareRow[]): string | null => {
  const ran = rows.filter((r) => r.status !== 'not-eligible-language');
  if (ran.length < 2) return null;
  const classes = new Set(ran.map((r) => r.identity.paramsBillions));
  if (classes.size < 2) return null;
  const listed = ran.map((r) => `${r.label} ${r.identity.params} ${r.identity.quantization}`);
  return `Comparing different model sizes (${listed.join(' vs ')}) — the delta is not purely engine quality.`;
};

export interface CompareEnginesInput {
  /** The ONE document every engine sees. */
  readonly document: string;
  /** Every engine that could run right now (engine.ts: readyEngines). */
  readonly engines: readonly GenerationEngine[];
  /** Injectable clock so latency is assertable. */
  readonly now?: () => number;
}

/**
 * Run the comparison. One generate() per eligible engine, each on the SAME
 * document reduced to that engine's own input cap (through the chunking path —
 * see engineLimits.prepareInput). Never throws: an engine that blows up becomes
 * an 'error' row so the other engines' results still render.
 */
export const compareEngines = async ({
  document,
  engines,
  now = () => Date.now(),
}: CompareEnginesInput): Promise<CompareOutcome> => {
  const language = detectContentLanguage(document);
  const rows: CompareRow[] = [];
  for (const engine of engines) {
    const identity = engineIdentityOf(engine);
    const limits = engineLimitsOf(engine);
    const base = {
      kind: engine.kind,
      label: identity.label,
      matchup: describeIdentity(identity),
      identity,
      limits,
      sendsTextOffDevice: engine.kind === 'remote',
    } as const;

    // Capability routing FIRST — never run an engine that cannot serve this
    // language just to render its failure.
    if (engine.kind === 'nano' && !nanoCanServe(language)) {
      rows.push({
        ...base,
        status: 'not-eligible-language',
        text: null,
        rejection: null,
        scores: null,
        ms: 0,
        error: null,
        inputChars: document.length,
        processedChars: 0,
        inputReduced: false,
      });
      continue;
    }

    const prepared = prepareInput(document, limits.maxInputChars);
    const started = now();
    let raw: string;
    try {
      raw = await engine.generate(`${GIST_PROMPT_PREFIX}\n${prepared.text}`, GIST_GENERATION);
    } catch (err) {
      rows.push({
        ...base,
        status: 'error',
        text: null,
        rejection: null,
        scores: null,
        ms: now() - started,
        error: err instanceof Error ? err.message : String(err),
        inputChars: prepared.inputChars,
        processedChars: prepared.processedChars,
        inputReduced: prepared.reduced,
      });
      continue;
    }
    const ms = now() - started;
    const shared = {
      ...base,
      ms,
      error: null,
      inputChars: prepared.inputChars,
      processedChars: prepared.processedChars,
      inputReduced: prepared.reduced,
    };
    if (isAbstention(raw)) {
      rows.push({ ...shared, status: 'abstained', text: null, rejection: null, scores: null });
      continue;
    }
    // Score against the text the engine ACTUALLY SAW: groundedness measured
    // against a document the model was never shown would punish the engine with
    // the smaller input cap for a reduction we imposed.
    const scores = scoreGeneration(raw, prepared.text);
    const verdict = validateGeneration(raw, {
      kind: 'gist',
      language,
      prompt: GIST_PROMPT_PREFIX,
    });
    rows.push(
      verdict.ok
        ? { ...shared, status: 'ok', text: verdict.text, rejection: null, scores }
        : { ...shared, status: 'rejected', text: raw, rejection: verdict.reason, scores },
    );
  }

  const winner = pickWinner(rows);
  return {
    rows,
    winnerKind: winner === null ? null : winner.kind,
    headline:
      winner === null
        ? NO_USABLE_SUMMARY
        : `winner: ${winner.matchup} · ground ${(winner.scores?.groundedness ?? 0).toFixed(2)}`,
    sizeCaveat: sizeCaveatFor(rows),
    language,
  };
};

/** Row copy for a status that produced no text. One sentence each. */
export const compareStatusCopy = (row: CompareRow): string => {
  switch (row.status) {
    case 'ok':
      return 'accepted';
    case 'rejected':
      return `REJECTED: ${row.rejection ?? 'unknown'}`;
    case 'abstained':
      return 'the model declined to summarize this document';
    case 'error':
      return `error: ${row.error ?? 'unknown'}`;
    case 'not-eligible-language':
      return 'not eligible (language)';
  }
};
