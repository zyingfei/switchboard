interface UnionFindNode {
  parent: string;
  rank: number;
  insertionIndex: number;
}

export interface UnionFindComponent {
  readonly root: string;
  readonly members: readonly string[];
}

export class UnionFind {
  private readonly nodes = new Map<string, UnionFindNode>();

  add(key: string): void {
    if (this.nodes.has(key)) return;
    this.nodes.set(key, {
      parent: key,
      rank: 0,
      insertionIndex: this.nodes.size,
    });
  }

  union(a: string, b: string): string {
    this.add(a);
    this.add(b);

    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;

    const nodeA = this.getNode(rootA);
    const nodeB = this.getNode(rootB);

    if (nodeA.rank > nodeB.rank) {
      nodeB.parent = rootA;
      return rootA;
    }
    if (nodeB.rank > nodeA.rank) {
      nodeA.parent = rootB;
      return rootB;
    }

    if (nodeA.insertionIndex <= nodeB.insertionIndex) {
      nodeB.parent = rootA;
      nodeA.rank += 1;
      return rootA;
    }

    nodeA.parent = rootB;
    nodeB.rank += 1;
    return rootB;
  }

  find(key: string): string {
    const node = this.nodes.get(key);
    if (node === undefined) {
      throw new Error(`UnionFind key not found: ${key}`);
    }
    if (node.parent === key) return key;
    node.parent = this.find(node.parent);
    return node.parent;
  }

  members(componentRoot: string): readonly string[] {
    const root = this.find(componentRoot);
    const out: string[] = [];
    for (const key of this.nodes.keys()) {
      if (this.find(key) === root) out.push(key);
    }
    return out;
  }

  components(): readonly UnionFindComponent[] {
    const grouped = new Map<string, string[]>();
    for (const key of this.nodes.keys()) {
      const root = this.find(key);
      const members = grouped.get(root);
      if (members === undefined) {
        grouped.set(root, [key]);
      } else {
        members.push(key);
      }
    }

    return [...grouped.entries()].map(([root, members]) => ({ root, members }));
  }

  private getNode(key: string): UnionFindNode {
    const node = this.nodes.get(key);
    if (node === undefined) {
      throw new Error(`UnionFind key not found: ${key}`);
    }
    return node;
  }
}
