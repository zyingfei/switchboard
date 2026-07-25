// Recurring-thread workstream self-nomination (domain).
//
// A chat thread the user keeps returning to — visited N times across
// several days — is the strongest work-signal the system sees, yet
// today it can render as an empty card: its only attribution anchor is
// a lone `thread_references_url` edge whose similarity neighborhood is
// too diffuse for any single workstream candidate to win, so the
// resolver honestly abstains. The user's real workstreams ARE their
// recurring threads. When a thread is (a) revisited enough, (b) has no
// workstream home, and (c) has no attribution candidate above the
// suggest threshold, the companion emits a `selfNomination` block so
// the panel can offer "start a workstream from this thread" instead of
// a dead-end.
//
// This module is pure domain (no HTTP / storage / env). The route
// adapter supplies the already-measured signals (visit count, distinct
// days, membership, whether a candidate survived the suggest
// threshold, ignored state) and the tunable minimum-visit threshold.

// Default recurrence threshold: three visits is the point at which a
// revisit is deliberate rather than incidental. Env-tunable at the
// route boundary (SIDETRACK_THREAD_SELF_NOMINATION_MIN_VISITS); the
// domain takes it as a parameter so it stays free of process.env.
export const DEFAULT_SELF_NOMINATION_MIN_VISITS = 3;

// A thread must span at least two distinct calendar days to count as a
// recurring home — a burst of N visits inside one sitting is a single
// work session, not a standing workstream.
export const SELF_NOMINATION_MIN_DISTINCT_DAYS = 2;

export interface ThreadSelfNominationSignals {
  // The thread's title as captured (may carry provider chrome).
  readonly title: string;
  // Provider slug for boilerplate stripping (e.g. 'chatgpt').
  readonly provider?: string;
  // How many times the thread URL was visited (URL projection).
  readonly visitCount: number;
  // Distinct UTC days the thread was visited (from visit events).
  readonly distinctDays: number;
  // True when the thread already belongs to a workstream.
  readonly hasWorkstream: boolean;
  // True when the resolver produced >=1 candidate above the suggest
  // threshold (i.e. the panel would show a real suggestion already).
  readonly hasSuggestionAboveThreshold: boolean;
  // True when the user explicitly ignored this thread's URL
  // (Ignore — admin / noise). Never nominate an ignored thread.
  readonly isIgnored: boolean;
  // Recurrence threshold (defaults to DEFAULT_SELF_NOMINATION_MIN_VISITS).
  readonly minVisits?: number;
}

export type ThreadSelfNominationReason =
  | 'already-filed'
  | 'ignored'
  | 'has-suggestion'
  | 'below-visit-threshold'
  | 'below-day-threshold';

export interface ThreadSelfNomination {
  readonly eligible: boolean;
  readonly visitCount: number;
  readonly distinctDays: number;
  // Cleaned title the panel pre-fills into the editable "new
  // workstream" field. Present only when eligible.
  readonly suggestedTitle?: string;
  // Why the thread was NOT nominated — surfaced for observability /
  // tests, never rendered. Absent when eligible.
  readonly reason?: ThreadSelfNominationReason;
}

// Provider display / chrome tags a captured thread title may carry.
// Chat providers usually store the bare conversation title, but some
// capture paths append " - ChatGPT", " | Claude", "ChatGPT - <title>",
// etc. Strip a leading or trailing provider tag so the suggested
// workstream name reads as the topic, not the tool.
const PROVIDER_CHROME: readonly string[] = [
  'ChatGPT',
  'OpenAI',
  'Claude',
  'Anthropic',
  'Gemini',
  'Google Gemini',
  'Bard',
  'Copilot',
  'Perplexity',
];

const SEPARATORS = ['-', '–', '—', '|', '·', ':'] as const;

const trimSeparators = (value: string): string => {
  let result = value.trim();
  // Peel matched leading/trailing separators + surrounding space.
  let changed = true;
  while (changed) {
    changed = false;
    for (const sep of SEPARATORS) {
      if (result.startsWith(sep)) {
        result = result.slice(sep.length).trim();
        changed = true;
      }
      if (result.endsWith(sep)) {
        result = result.slice(0, result.length - sep.length).trim();
        changed = true;
      }
    }
  }
  return result;
};

// Remove one leading or trailing "<sep> Provider" / "Provider <sep>"
// chrome segment (case-insensitive). Conservative: only strips when the
// provider token is a whole separated segment, so a title like "How
// ChatGPT ranks" (provider mid-sentence, no separator) is untouched.
export const cleanThreadTitle = (rawTitle: string, _provider?: string): string => {
  const original = (rawTitle ?? '').trim();
  if (original.length === 0) return original;
  let title = original;
  const sepClass = '[\\-–—|·:]';
  for (const provider of PROVIDER_CHROME) {
    const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Trailing "  - Provider" / "| Provider" chrome.
    const trailing = new RegExp(`\\s*${sepClass}\\s*${escaped}\\s*$`, 'i');
    // Leading "Provider -  " / "Provider | " chrome.
    const leading = new RegExp(`^\\s*${escaped}\\s*${sepClass}\\s*`, 'i');
    title = title.replace(trailing, '');
    title = title.replace(leading, '');
  }
  const cleaned = trimSeparators(title);
  // Never collapse to empty — if stripping removed everything (the
  // title WAS just the provider), fall back to the original so the
  // user always has something to rename.
  return cleaned.length > 0 ? cleaned : original;
};

// Decide whether a thread self-nominates as a new workstream. Pure:
// all signals are supplied by the caller. Order of the guards is
// significant — the reasons are reported most-specific-first so tests
// (and the health surface) can assert the exact abstention cause.
export const evaluateThreadSelfNomination = (
  signals: ThreadSelfNominationSignals,
): ThreadSelfNomination => {
  const minVisits = signals.minVisits ?? DEFAULT_SELF_NOMINATION_MIN_VISITS;
  const base = {
    visitCount: signals.visitCount,
    distinctDays: signals.distinctDays,
  } as const;

  // (b) A thread with a home is already organized — never nominate.
  if (signals.hasWorkstream) {
    return { ...base, eligible: false, reason: 'already-filed' };
  }
  // Respect an explicit user "Ignore (admin / noise)" — never nudge.
  if (signals.isIgnored) {
    return { ...base, eligible: false, reason: 'ignored' };
  }
  // (c) A real suggestion already exists — the panel shows it; don't
  // compete with the resolver's own pick.
  if (signals.hasSuggestionAboveThreshold) {
    return { ...base, eligible: false, reason: 'has-suggestion' };
  }
  // (a1) Recurrence floor by visit count.
  if (signals.visitCount < minVisits) {
    return { ...base, eligible: false, reason: 'below-visit-threshold' };
  }
  // (a2) Recurrence floor by distinct days — one sitting isn't a home.
  if (signals.distinctDays < SELF_NOMINATION_MIN_DISTINCT_DAYS) {
    return { ...base, eligible: false, reason: 'below-day-threshold' };
  }

  return {
    ...base,
    eligible: true,
    suggestedTitle: cleanThreadTitle(signals.title, signals.provider),
  };
};
