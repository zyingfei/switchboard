import type { BacThreadRecord } from './model';

export interface CanvasTextNode {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

export interface CanvasFileNode {
  id: string;
  type: 'file';
  x: number;
  y: number;
  width: number;
  height: number;
  file: string;
}

export interface CanvasGroupNode {
  id: string;
  type: 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasGroupNode;

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: [];
}

const toHexId = (seed: string): string => {
  let left = 0x811c9dc5;
  let right = 0x45d9f3b;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 0x01000193);
    right ^= code + index;
    right = Math.imul(right, 0x27d4eb2d);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
};

export const buildSwitchboardCanvas = (
  project: string,
  topic: string,
  threads: BacThreadRecord[],
): CanvasDocument => {
  const nodes: CanvasNode[] = [
    {
      id: toHexId(`project:${project}`),
      type: 'text',
      x: -280,
      y: -160,
      width: 360,
      height: 160,
      text: `# ${project}\n\nTracked threads: ${threads.length}`,
    },
    {
      id: toHexId(`group:${project}:${topic}`),
      type: 'group',
      x: -320,
      y: 60,
      width: 760,
      height: 260,
      label: topic,
    },
  ];

  threads.forEach((thread, index) => {
    nodes.push({
      id: toHexId(`file:${thread.bacId}`),
      type: 'file',
      x: -260 + index * 260,
      y: 130,
      width: 220,
      height: 140,
      file: thread.path,
    });
  });

  return {
    nodes,
    edges: [],
  };
};

export const serializeCanvas = (canvas: CanvasDocument): string => `${JSON.stringify(canvas, null, 2)}\n`;

export const validateCanvasDocument = (canvas: CanvasDocument): string[] => {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of canvas.nodes) {
    if (!/^[0-9a-f]{16}$/u.test(node.id)) {
      errors.push(`Node ${node.id} is not a 16-char hex id`);
    }
    if (ids.has(node.id)) {
      errors.push(`Duplicate node id ${node.id}`);
    }
    ids.add(node.id);
    if (node.width <= 0 || node.height <= 0) {
      errors.push(`Node ${node.id} has invalid dimensions`);
    }
    if (node.type === 'file' && !node.file.endsWith('.md')) {
      errors.push(`File node ${node.id} does not point at a markdown note`);
    }
  }
  return errors;
};
