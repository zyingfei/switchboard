import { describe, expect, it } from 'vitest';
import { baseMentionsProjectFilter, buildWhereWasIBase } from '../../src/obsidian/base';
import { buildSwitchboardCanvas, serializeCanvas, validateCanvasDocument } from '../../src/obsidian/canvas';
import type { BacThreadRecord } from '../../src/obsidian/model';

const record = {
  bacId: 'thread_001',
  path: 'Projects/SwitchBoard/MCP discussion.md',
  title: 'MCP discussion',
  provider: 'claude',
  sourceUrl: 'https://claude.ai/chat/mock',
  status: 'tracked',
  project: 'SwitchBoard',
  topic: 'Security',
  tags: ['bac/thread'],
  related: ['[[BRAINSTORM]]'],
  content: '# MCP discussion',
} satisfies BacThreadRecord;

describe('canvas and base builders', () => {
  it('builds spec-shaped canvas nodes with 16-char hex ids', () => {
    const canvas = buildSwitchboardCanvas('SwitchBoard', 'Security', [record]);
    const serialized = serializeCanvas(canvas);

    expect(validateCanvasDocument(canvas)).toEqual([]);
    expect(serialized).toContain('"type": "file"');
    expect(serialized).toContain('Projects/SwitchBoard/MCP discussion.md');
    expect(canvas.nodes.every((node) => /^[0-9a-f]{16}$/u.test(node.id))).toBe(true);
  });

  it('builds a where-was-i base filtered by BAC frontmatter', () => {
    const base = buildWhereWasIBase({ project: 'SwitchBoard' });

    expect(baseMentionsProjectFilter(base, 'SwitchBoard')).toBe(true);
    expect(base).toContain('views:');
    expect(base).toContain('type: table');
    expect(base).toContain('status != "archived"');
  });
});
