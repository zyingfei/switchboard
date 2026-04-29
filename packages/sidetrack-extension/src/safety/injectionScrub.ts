// §24.10 primitive: scrub outbound text for prompt-injection patterns.
//
// Inputs: any string the user (or a queue item) is about to paste/send
// into a provider chat composer.
// Output: a verdict + a wrapped/replaced string the caller can ship.
//
// The wrapping strategy comes from PRD §24.10 — when injection is
// detected, we don't refuse; we wrap the suspect content in
// `<context>...</context>` markers so the receiving model can be told
// to treat it as untrusted data, not instructions.
//
// This module is pure — no DOM access, no storage, no network. Both
// the side-panel-driven dispatch path and the (future) auto-send
// drain wire through it.

export interface InjectionScrubResult {
  readonly detected: boolean;
  readonly patternsMatched: readonly string[];
  readonly originalLength: number;
  // Wrapped output. When detected=false, this equals input.
  readonly wrapped: string;
}

interface InjectionPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

// Conservative pattern set. False positives are tolerable (we wrap
// rather than refuse, so a wrap-marker on benign text is just noise).
// False negatives are not — every pattern below has appeared in real
// jailbreak attempts captured in published prompt-injection corpuses.
//
// The patterns are intentionally lower-case and case-insensitive (`i`
// flag) — almost every published injection uses sentence case.
const PATTERNS: readonly InjectionPattern[] = [
  { id: 'ignore-previous', pattern: /\bignore\s+(?:the\s+)?(?:previous|prior|all|above)/iu },
  { id: 'disregard-instructions', pattern: /\bdisregard\s+(?:the\s+)?(?:previous|prior|all|above|system)/iu },
  { id: 'forget-instructions', pattern: /\bforget\s+(?:everything|your\s+(?:instructions|training|prompt))/iu },
  { id: 'you-are-now', pattern: /\byou\s+are\s+now\s+(?:a|an|the)\s+/iu },
  { id: 'pretend-you-are', pattern: /\bpretend\s+(?:to\s+be|you\s+are)\b/iu },
  { id: 'developer-mode', pattern: /\b(?:developer|dev|debug|admin|jailbreak|dan)\s+mode\b/iu },
  { id: 'system-prompt-leak', pattern: /\b(?:reveal|show|print|output|display)\s+(?:your\s+)?(?:system\s+prompt|instructions|guidelines)/iu },
  { id: 'role-injection', pattern: /^\s*(?:system|assistant|developer|admin)\s*[:>-]/imu },
  { id: 'context-injection', pattern: /<\s*\/?(?:system|instructions|context)\b/iu },
  { id: 'stop-following', pattern: /\bstop\s+following\s+(?:your|the)\s+(?:rules|guidelines|instructions)/iu },
  { id: 'between-tags', pattern: /\[\s*(?:system|admin|root|developer)\s*\]/iu },
];

const CONTEXT_OPEN = '<context untrusted="true">';
const CONTEXT_CLOSE = '</context>';

// True when the input ALREADY has Sidetrack context-tag wrapping —
// avoids double-wrapping if the same text passes through twice.
const isAlreadyWrapped = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.startsWith(CONTEXT_OPEN) && trimmed.endsWith(CONTEXT_CLOSE);
};

export const scanForInjection = (input: string): InjectionScrubResult => {
  const matched: string[] = [];
  for (const p of PATTERNS) {
    if (p.pattern.test(input)) {
      matched.push(p.id);
    }
  }
  if (matched.length === 0 || isAlreadyWrapped(input)) {
    return {
      detected: matched.length > 0,
      patternsMatched: matched,
      originalLength: input.length,
      wrapped: input,
    };
  }
  return {
    detected: true,
    patternsMatched: matched,
    originalLength: input.length,
    wrapped: `${CONTEXT_OPEN}\n${input}\n${CONTEXT_CLOSE}`,
  };
};
