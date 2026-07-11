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
    // US SSN — 3-2-4 with a separator. Requiring the dash/space avoids
    // colliding with the 9-digit runs that show up in ordinary numbers.
    category: 'ssn',
    pattern: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/gu,
    replacement: '[ssn]',
  },
  {
    category: 'card-number',
    pattern: /\b(?:\d[ -]?){15,}\d\b/gu,
    replacement: '[card-number]',
  },
  {
    // Phone number — E.164 / North-American shapes with a separator or
    // parenthesised area code. Runs AFTER card-number so a 16-digit PAN
    // isn't clipped into a phone match; the {15,} card rule already
    // consumed those. Requires at least one non-digit separator so a
    // bare 10-digit id doesn't trip it.
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

  for (const rule of rules) {
    output = output.replace(rule.pattern, () => {
      matched += 1;
      categories.add(rule.category);
      return rule.replacement;
    });
  }

  return { output, matched, categories: [...categories] };
};
