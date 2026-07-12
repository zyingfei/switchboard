export interface RedactionResult {
  readonly output: string;
  readonly matched: number;
  readonly categories: readonly string[];
}

interface RedactionRule {
  readonly category: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

// Luhn checksum — returns true when the digit string passes.
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

// Card-shaped grouping patterns used as an additional signal.
// Matches the common printed/typed formats:
//   4-4-4-4  (Visa/MC/Discover 16-digit)
//   4-4-4-4-3 (19-digit)
//   4-6-5     (Amex 15-digit, space-separated)
//   13-digit compact Visa
// A separator is required between groups (space or dash) — a solid
// 16-digit run of digits with no separator is treated as an opaque ID
// UNLESS it passes Luhn on its own (see cardNumberFilter below).
const CARD_GROUP_PATTERN =
  /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5}|\d{13})\b/gu;

// Broad digit-run pattern — catches 13-19 consecutive digit sequences
// (including space/dash-separated). This is intentionally wide; the
// cardNumberFilter below decides whether to actually redact.
const CARD_DIGIT_RUN_PATTERN = /\b(?:\d[ -]?){12,}\d\b/gu;

// Returns the replacement string if the matched text should be
// redacted as a card number, or null to pass it through unchanged.
// Rules (both must hold to redact):
//   1. The digit count is 13-19 (real cards are never shorter or longer).
//   2. The number passes Luhn OR the text matches a card grouping pattern.
//
// A bare 16-19 digit ID with no card grouping AND failing Luhn passes through.
const cardNumberFilter = (match: string): string | null => {
  const digits = match.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return null;

  const hasCardGrouping = CARD_GROUP_PATTERN.test(match);
  // Reset lastIndex — the /g flag keeps state between test() calls.
  CARD_GROUP_PATTERN.lastIndex = 0;

  if (luhnValid(digits) || hasCardGrouping) return '[card-number]';
  return null;
};

const rules: readonly RedactionRule[] = [
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
    // AWS access key id — the fixed AKIA prefix + 16 base32 chars. The
    // wider ASIA/AGPA/etc. families exist but AKIA is the long-lived
    // credential that actually leaks; keep the pattern tight.
    category: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    replacement: '[aws-access-key]',
  },
  {
    // AWS secret access key when it's labelled — a bare 40-char base64
    // blob is too generic to redact safely (false-positives on hashes),
    // so we require the `aws_secret...` assignment context that appears
    // in pasted credential blocks and .env dumps.
    category: 'aws-secret-key',
    pattern:
      /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/giu,
    replacement: 'aws_secret_access_key=[aws-secret-key]',
  },
  {
    category: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: '[email]',
  },
  {
    // US SSN — 3-2-4 with a dash or space separator. Requiring the
    // separator avoids colliding with 9-digit runs in ordinary numbers.
    // KNOWN OVER-MATCH: ticket refs and part numbers that happen to
    // follow the NNN-NN-NNNN shape (e.g. "REQ-12-3456" would NOT match
    // because of the leading alpha chars, but a bare "123-45-6789" in a
    // part number catalogue WOULD). The shape is inherently ambiguous —
    // no purely syntactic rule can distinguish SSN from ticket/part.
    // Negative tests for non-SSN contexts are in redaction.test.ts.
    category: 'ssn',
    pattern: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/gu,
    replacement: '[ssn]',
  },
  {
    // Phone number — E.164 / North-American shapes with a separator or
    // parenthesised area code. Runs AFTER card-number (applied below via
    // cardNumberFilter) so a 16-digit PAN isn't clipped into a phone
    // match. Requires at least one non-digit separator so a bare
    // 10-digit id doesn't trip it.
    category: 'phone',
    pattern:
      /(?<![\d.])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b/gu,
    replacement: '[phone]',
  },
];

export const redact = (input: string): RedactionResult => {
  let output = input;
  let matched = 0;
  const categories = new Set<string>();

  // Apply card-number rule first using the Luhn-gated filter.
  // The broad CARD_DIGIT_RUN_PATTERN catches candidate sequences;
  // cardNumberFilter decides whether each one is actually card-shaped.
  output = output.replace(CARD_DIGIT_RUN_PATTERN, (match) => {
    const replacement = cardNumberFilter(match);
    if (replacement !== null) {
      matched += 1;
      categories.add('card-number');
      return replacement;
    }
    return match;
  });

  for (const rule of rules) {
    output = output.replace(rule.pattern, () => {
      matched += 1;
      categories.add(rule.category);
      return rule.replacement;
    });
  }

  return { output, matched, categories: [...categories] };
};
