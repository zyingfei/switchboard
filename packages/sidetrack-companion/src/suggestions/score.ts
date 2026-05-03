export interface ThreadSummary {
  readonly id: string;
}

export interface WorkstreamSummary {
  readonly id: string;
}

export interface SignalSet {
  readonly lexical: Readonly<Record<string, number>>;
  readonly vector: Readonly<Record<string, number>>;
  readonly link: Readonly<Record<string, number>>;
}

export interface Suggestion {
  readonly workstreamId: string;
  readonly score: number;
  readonly breakdown: {
    readonly lexical: number;
    readonly vector: number;
    readonly link: number;
  };
}

const scoreFor = (signals: SignalSet, workstreamId: string): Suggestion => {
  const lexical = signals.lexical[workstreamId] ?? 0;
  const vector = signals.vector[workstreamId] ?? 0;
  const link = signals.link[workstreamId] ?? 0;
  return {
    workstreamId,
    score: Math.min(Math.max(lexical * 0.3 + vector * 0.5 + link * 0.2, 0), 1),
    breakdown: { lexical, vector, link },
  };
};

export const scoreSuggestions = (
  input: {
    readonly thread: ThreadSummary;
    readonly workstreams: readonly WorkstreamSummary[];
    readonly signals: SignalSet;
  },
  opts: { readonly threshold?: number } = {},
): readonly Suggestion[] => {
  const threshold = opts.threshold ?? 0.55;
  void input.thread;
  return input.workstreams
    .map((workstream) => scoreFor(input.signals, workstream.id))
    .filter((suggestion) => suggestion.score >= threshold)
    .sort((left, right) => right.score - left.score);
};
