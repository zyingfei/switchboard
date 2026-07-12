// F01+F31: the single funnel every outbound dispatch path flows
// through before the text is rendered-for-copy or auto-sent.
//
// The audit's #1 ship-blocker was that redaction only ran on the
// companion's STORED copy while the clipboard/auto-send paths shipped
// the pre-redaction original. This module inverts that: whatever the
// user pastes or the drain types is the SAFE text produced here.
//
// Two entry shapes, one output:
//   - preflightOutbound(text, provider): compose SAFE text locally —
//     applies the local redaction rules + injection scrub + token
//     estimate. Used when there is no companion round-trip (clipboard
//     copy, redispatch, auto-send of an already-recorded packet).
//   - preflightCompanionBody(companionBody, provider): the companion
//     already redacted; trust its output but still run the injection
//     scrub + token estimate so every path emits the same verdict
//     shape. The local redaction re-runs as an idempotent safety net —
//     redacting already-redacted text is a no-op (placeholders don't
//     match the secret patterns).
//
// This module is pure — no DOM, no storage, no network — so both the
// side-panel dispatch paths and the background auto-send handler can
// import it.

import { scanForInjection } from '../safety/injectionScrub';
import { estimateTokensFast } from '../safety/preflight';

// Per-provider chat-surface context windows (approximations — the
// companion's safety/tokenBudget.ts carries the authoritative map and
// the same citations). Mirrored here because the side-panel/background
// bundles don't round-trip to the companion for local composition.
//   - chatgpt: ~128K on GPT-4o-class models.
//   - claude:  ~200K chat-safe floor (API windows reach 1M; claude.ai
//              truncates well below that).
//   - gemini:  ~1M long-context surface.
//   - other:   200K conservative default.
export const OUTBOUND_TOKEN_THRESHOLDS = {
  chatgpt: 128_000,
  claude: 200_000,
  gemini: 1_000_000,
  other: 200_000,
} as const;

export type OutboundProvider = keyof typeof OUTBOUND_TOKEN_THRESHOLDS;

export const outboundTokenThreshold = (provider: string): number =>
  provider in OUTBOUND_TOKEN_THRESHOLDS
    ? OUTBOUND_TOKEN_THRESHOLDS[provider as OutboundProvider]
    : OUTBOUND_TOKEN_THRESHOLDS.other;

interface RedactionRule {
  readonly category: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

// Luhn checksum — mirrors the identical helper in
// packages/sidetrack-companion/src/safety/redaction.ts.
// Returns true when the digit string passes the check.
// Used to gate card-number redaction so numeric IDs (snowflakes,
// epoch-nanos, Stripe-style i64s) that happen to be 16-19 digits long
// are NOT silently rewritten to '[card-number]'.
const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let odd = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i]!, 10);
    if (odd) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    odd = !odd;
  }
  return sum % 10 === 0;
};

// Card-shaped grouping pattern — see companion/redaction.ts for
// the rationale. Mirrors CARD_GROUP_PATTERN exactly. A bare 13-digit
// run is intentionally excluded: without a separator it is a 13-digit
// epoch-millis / EAN-13, so it redacts only via the Luhn branch.
const CARD_GROUP_PATTERN =
  /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5})\b/gu;

// Broad digit-run pattern. Intentionally wide; cardNumberFilter gates
// actual redaction — mirrors CARD_DIGIT_RUN_PATTERN in companion.
const CARD_DIGIT_RUN_PATTERN = /\b(?:\d[ -]?){12,}\d\b/gu;

const cardNumberFilter = (match: string): string | null => {
  const digits = match.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return null;
  const hasCardGrouping = CARD_GROUP_PATTERN.test(match);
  CARD_GROUP_PATTERN.lastIndex = 0;
  if (luhnValid(digits) || hasCardGrouping) return '[card-number]';
  return null;
};

// Local mirror of packages/sidetrack-companion/src/safety/redaction.ts
// rule shapes — kept in sync so a locally-composed packet is scrubbed
// with the same categories the companion applies on the round-trip.
// Patterns carry the global flag so replace() clears every match.
// NOTE: card-number is handled outside this list via cardNumberFilter
// above (requires Luhn validation, not a simple pattern replacement).
const LOCAL_REDACTION_RULES: readonly RedactionRule[] = [
  {
    category: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gu,
    replacement: '[anthropic-key]',
  },
  {
    category: 'openai-key',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{40,}\b/gu,
    replacement: '[openai-key]',
  },
  {
    category: 'github-token',
    pattern: /\b(?:ghp_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/gu,
    replacement: '[github-token]',
  },
  {
    category: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    replacement: '[aws-access-key]',
  },
  {
    category: 'aws-secret-key',
    pattern: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/giu,
    replacement: 'aws_secret_access_key=[aws-secret-key]',
  },
  {
    category: 'bearer-token',
    pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
    replacement: '[bearer-token]',
  },
  {
    category: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gu,
    replacement: '[bearer-token]',
  },
  {
    category: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: '[email]',
  },
  {
    // KNOWN OVER-MATCH: ticket refs and part numbers following NNN-NN-NNNN
    // will also match. The shape is inherently ambiguous — no purely
    // syntactic rule distinguishes SSN from part numbers. See negative
    // tests in outboundPreflight.test.ts.
    category: 'ssn',
    pattern: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/gu,
    replacement: '[ssn]',
  },
  {
    category: 'phone',
    pattern:
      /(?<![\d.])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/gu,
    replacement: '[phone]',
  },
];

export interface OutboundRedaction {
  readonly applied: boolean;
  readonly matched: number;
  // Applied rule ids (categories) — matches the companion's
  // `redaction.rules` field so both sides speak the same vocabulary.
  readonly rules: readonly string[];
}

const applyLocalRedaction = (input: string): { readonly output: string } & OutboundRedaction => {
  let output = input;
  let matched = 0;
  const ruleSet = new Set<string>();

  // Apply card-number rule first with Luhn gating — identical logic to
  // companion/redaction.ts so the two files stay in sync.
  output = output.replace(CARD_DIGIT_RUN_PATTERN, (match) => {
    const replacement = cardNumberFilter(match);
    if (replacement !== null) {
      matched += 1;
      ruleSet.add('card-number');
      return replacement;
    }
    return match;
  });

  for (const rule of LOCAL_REDACTION_RULES) {
    output = output.replace(rule.pattern, () => {
      matched += 1;
      ruleSet.add(rule.category);
      return rule.replacement;
    });
  }
  return { output, applied: matched > 0, matched, rules: [...ruleSet] };
};

export interface OutboundPreflightVerdict {
  // The SAFE text every caller ships. Redaction + injection scrub
  // applied. Never the raw original.
  readonly safeText: string;
  readonly redaction: OutboundRedaction;
  readonly injectionDetected: boolean;
  readonly injectionPatternsMatched: readonly string[];
  readonly tokenEstimate: number;
  readonly tokenThreshold: number;
  readonly tokenBudgetExceeded: boolean;
}

interface PreflightOptions {
  // When the caller already has the companion-redacted body, pass it
  // as `companionBody`. The local redaction still runs as an
  // idempotent safety net but the injection scrub is what matters here
  // (the companion doesn't scrub). Defaults to running the full local
  // redaction over `text`.
  readonly companionBody?: string;
}

// The one preflight all outbound text flows through. Order:
//   1. Redaction (companion-preferred; local scrub as the source or
//      the safety net).
//   2. Injection scrub — wraps suspect content in <context> markers,
//      never refuses (so there's always safe text to ship).
//   3. Token estimate + per-provider budget verdict.
export const preflightOutbound = (
  text: string,
  provider: string,
  options: PreflightOptions = {},
): OutboundPreflightVerdict => {
  // Prefer the companion body when supplied. Re-run the local rules
  // over it anyway — idempotent, and it catches anything the companion
  // rule set predates without ever un-redacting.
  const source = options.companionBody ?? text;
  const redaction = applyLocalRedaction(source);
  const scrub = scanForInjection(redaction.output);
  const tokenEstimate = estimateTokensFast(scrub.wrapped);
  const tokenThreshold = outboundTokenThreshold(provider);
  return {
    safeText: scrub.wrapped,
    redaction: { applied: redaction.applied, matched: redaction.matched, rules: redaction.rules },
    injectionDetected: scrub.detected,
    injectionPatternsMatched: scrub.patternsMatched,
    tokenEstimate,
    tokenThreshold,
    tokenBudgetExceeded: tokenEstimate > tokenThreshold,
  };
};

// Convenience wrapper for the companion round-trip path — the redacted
// body is the trusted input; still scrub + token-check it.
export const preflightCompanionBody = (
  companionBody: string,
  provider: string,
): OutboundPreflightVerdict => preflightOutbound(companionBody, provider, { companionBody });
