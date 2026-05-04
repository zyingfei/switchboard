export type Matcher =
  | { readonly kind: 'workstream'; readonly value: string }
  | { readonly kind: 'provider'; readonly value: string }
  | { readonly kind: 'urlPattern'; readonly value: string };

export interface Bucket {
  readonly id: string;
  readonly label: string;
  readonly vaultRoot: string;
  readonly matchers: readonly Matcher[];
}

export interface BucketPickInput {
  readonly workstreamId?: string;
  readonly provider?: string;
  readonly url?: string;
}
