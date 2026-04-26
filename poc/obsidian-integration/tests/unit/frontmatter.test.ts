import { describe, expect, it } from 'vitest';
import {
  getFrontmatterString,
  getFrontmatterStringArray,
  parseFrontmatter,
  serializeFrontmatter,
  setFrontmatterField,
} from '../../src/obsidian/frontmatter';

describe('frontmatter mirror helpers', () => {
  it('serializes standard Obsidian properties', () => {
    const markdown = serializeFrontmatter({
      bac_id: 'thread_001',
      bac_type: 'thread',
      status: 'tracked',
      count: 2,
      pinned: true,
      tags: ['bac/thread', 'provider/claude'],
      related: ['[[BRAINSTORM]]'],
    });

    expect(markdown).toContain('bac_id: thread_001');
    expect(markdown).toContain('pinned: true');
    expect(markdown).toContain('  - bac/thread');
    expect(markdown).toContain('  - "[[BRAINSTORM]]"');
  });

  it('patches one frontmatter key without rewriting body sections', () => {
    const source = `---
bac_id: thread_001
project: Inbox
tags:
  - bac/thread
---
# Capture

## Notes

Keep this body.
`;

    const patched = setFrontmatterField(source, 'project', 'SwitchBoard');
    const withTags = setFrontmatterField(patched, 'tags', ['bac/thread', 'project/switchboard']);

    expect(getFrontmatterString(withTags, 'project')).toBe('SwitchBoard');
    expect(getFrontmatterStringArray(withTags, 'tags')).toEqual(['bac/thread', 'project/switchboard']);
    expect(withTags).toContain('Keep this body.');
    expect(withTags).toContain('## Notes');
  });

  it('parses wikilink arrays and scalar values', () => {
    const parsed = parseFrontmatter(`---
related:
  - "[[BRAINSTORM]]"
  - "[[SwitchBoard]]"
status: tracked
---
Body
`);

    expect(parsed.related).toEqual(['[[BRAINSTORM]]', '[[SwitchBoard]]']);
    expect(parsed.status).toBe('tracked');
  });
});
