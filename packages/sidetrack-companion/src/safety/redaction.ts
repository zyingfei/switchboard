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
    category: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: '[email]',
  },
  {
    category: 'card-number',
    pattern: /\b(?:\d[ -]?){15,}\d\b/gu,
    replacement: '[card-number]',
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
