export interface DomSkeletonNode {
  readonly tag: string;
  readonly hasId: boolean;
  readonly hasClass: boolean;
  readonly children: readonly DomSkeletonNode[];
}

export const canonicalizeDomSkeleton = (node: DomSkeletonNode): string =>
  `{"t":${JSON.stringify(node.tag)},"i":${String(node.hasId)},"c":${String(
    node.hasClass,
  )},"k":[${node.children.map((child) => canonicalizeDomSkeleton(child)).join(',')}]}`;
