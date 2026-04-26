import { describe, expect, it } from 'vitest';
import { appendUnderHeading } from '../../src/obsidian/headingPatch';

describe('heading patch helper', () => {
  it('appends under a heading without disturbing surrounding sections', () => {
    const source = `# Capture

## Notes

- Existing note.

## Untouched Section

Keep me.
`;

    const patched = appendUnderHeading(source, 'Notes', '- New note.');

    expect(patched).toContain('## Notes\n\n- Existing note.\n\n- New note.\n\n## Untouched Section');
    expect(patched).toContain('Keep me.');
  });

  it('creates the heading when it is absent', () => {
    const patched = appendUnderHeading('# Capture\n', 'Notes', '- New note.');

    expect(patched).toContain('## Notes\n\n- New note.');
  });
});
