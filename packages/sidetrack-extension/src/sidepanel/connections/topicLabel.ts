export interface TopicLabelMember {
  readonly canonicalUrl: string;
  readonly title: string;
  readonly focusedWindowMs: number;
}

export interface TopicLabelInput {
  readonly members: readonly TopicLabelMember[];
  readonly cohesion: number;
}

export interface TopicLabelResult {
  readonly label: string;
  readonly tooltip: string;
}

export const topicLabel = (topic: TopicLabelInput): TopicLabelResult => {
  const top = [...topic.members].sort((left, right) => {
    if (right.focusedWindowMs !== left.focusedWindowMs) {
      return right.focusedWindowMs - left.focusedWindowMs;
    }
    return left.canonicalUrl < right.canonicalUrl
      ? -1
      : left.canonicalUrl > right.canonicalUrl
        ? 1
        : 0;
  })[0];

  return {
    label:
      top === undefined
        ? '(untitled topic)'
        : top.title.trim().length > 0
          ? top.title
          : top.canonicalUrl,
    tooltip: `cohesion=${topic.cohesion.toFixed(2)} · members=${String(topic.members.length)}`,
  };
};
