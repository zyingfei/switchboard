export interface DurableTabGroupLink {
  readonly linkId: string;
  readonly title: string;
  readonly color: string;
  readonly workstreamId?: string;
  readonly orderedCanonicalUrls: readonly string[];
  readonly origin: 'system-suggested' | 'user-created';
}

export type TabGroupReconciliationResult =
  | { readonly action: 'silent-relink'; readonly link: DurableTabGroupLink }
  | { readonly action: 'show-relink-banner'; readonly candidates: readonly DurableTabGroupLink[] }
  | { readonly action: 'drop' };

export interface ObservedTabGroupShape {
  readonly title: string;
  readonly color: string;
  readonly orderedCanonicalUrls: readonly string[];
}

const sameOrderedSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const reconcileTabGroupLink = (
  observed: ObservedTabGroupShape,
  links: readonly DurableTabGroupLink[],
): TabGroupReconciliationResult => {
  const metadataMatches = links.filter(
    (link) => link.title === observed.title && link.color === observed.color,
  );
  const strong = metadataMatches.find((link) =>
    sameOrderedSet(link.orderedCanonicalUrls, observed.orderedCanonicalUrls),
  );
  if (strong !== undefined) return { action: 'silent-relink', link: strong };
  if (metadataMatches.length > 0) {
    return { action: 'show-relink-banner', candidates: metadataMatches };
  }
  return { action: 'drop' };
};
