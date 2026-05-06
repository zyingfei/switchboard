import { describe, expect, it } from 'vitest';

import {
  parseMarkdownLockSentinel,
  renderPromotedThreadMarkdown,
  renderThreadMarkdown,
  renderWorkstreamMarkdown,
} from './markdownProjection.js';

describe('renderWorkstreamMarkdown', () => {
  it('produces YAML frontmatter + a body heading for the title', () => {
    const md = renderWorkstreamMarkdown({
      bac_id: 'bac_workstream_1',
      revision: 'rev_a',
      title: 'Sidetrack / MVP',
      privacy: 'private',
    });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('bac_id: bac_workstream_1');
    expect(md).toContain('revision: rev_a');
    expect(md).toContain('kind: workstream');
    // "Sidetrack / MVP" has no YAML-special chars (the `/` is fine
    // bare, internal spaces are fine bare) so it stays unquoted.
    expect(md).toContain('title: Sidetrack / MVP');
    expect(md).toContain('privacy: private');
    expect(md).toMatch(/\n# Sidetrack \/ MVP\n/);
  });

  it('escapes YAML-special characters in titles + tags', () => {
    const md = renderWorkstreamMarkdown({
      bac_id: 'bac_w_2',
      revision: 'rev',
      title: 'foo: bar # baz',
      tags: ['plain-tag', 'has space', 'has:colon'],
    });
    // The colon and the standalone `#` (with leading space) trigger
    // quoting; internal whitespace alone does not.
    expect(md).toContain('title: "foo: bar # baz"');
    expect(md).toContain('  - plain-tag');
    expect(md).toContain('  - has space');
    expect(md).toContain('  - "has:colon"');
  });

  it('renders empty arrays as compact []', () => {
    const md = renderWorkstreamMarkdown({
      bac_id: 'bac_w_3',
      revision: 'rev',
      tags: [],
    });
    expect(md).toContain('tags: []');
  });

  it('emits Obsidian wiki-link children + checklist with checkbox state', () => {
    const md = renderWorkstreamMarkdown({
      bac_id: 'bac_w_4',
      revision: 'rev',
      children: ['bac_child_1', 'bac_child_2'],
      checklist: [
        { text: 'review M1', checked: false },
        { text: 'ship M2 closer', checked: true },
      ],
    });
    expect(md).toContain('## Child workstreams');
    expect(md).toContain('- [[bac_child_1]]');
    expect(md).toContain('- [[bac_child_2]]');
    expect(md).toContain('## Checklist');
    expect(md).toContain('- [ ] review M1');
    expect(md).toContain('- [x] ship M2 closer');
  });

  it('omits the children section when none present', () => {
    const md = renderWorkstreamMarkdown({
      bac_id: 'bac_w_5',
      revision: 'rev',
    });
    expect(md).not.toContain('## Child workstreams');
    expect(md).not.toContain('## Checklist');
  });

  it('falls back to bac_id when title is missing', () => {
    const md = renderWorkstreamMarkdown({ bac_id: 'bac_no_title', revision: 'rev' });
    expect(md).toContain('title: bac_no_title');
    expect(md).toMatch(/# bac_no_title/);
  });
});

describe('renderThreadMarkdown', () => {
  it('produces frontmatter with provider, url, status', () => {
    const md = renderThreadMarkdown({
      bac_id: 'bac_thread_1',
      revision: 'rev_t',
      provider: 'claude',
      threadUrl: 'https://claude.ai/chat/abc',
      title: 'VM live migration',
      status: 'tracked',
      trackingMode: 'auto',
    });
    expect(md).toContain('bac_id: bac_thread_1');
    expect(md).toContain('kind: thread');
    expect(md).toContain('provider: claude');
    expect(md).toContain('url: "https://claude.ai/chat/abc"');
    expect(md).toContain('status: tracked');
    expect(md).toContain('trackingMode: auto');
  });

  it('renders an [Open thread] link when threadUrl is present', () => {
    const md = renderThreadMarkdown({
      bac_id: 'bac_t',
      revision: 'rev',
      threadUrl: 'https://example.com/x',
      title: 'X',
    });
    expect(md).toContain('[Open thread](https://example.com/x)');
  });

  it('emits a workstream wiki-link when assigned', () => {
    const md = renderThreadMarkdown({
      bac_id: 'bac_t',
      revision: 'rev',
      title: 'X',
      primaryWorkstreamId: 'bac_ws_x',
    });
    expect(md).toContain('Workstream: [[bac_ws_x]]');
  });

  it('omits optional frontmatter rows when their value is undefined', () => {
    const md = renderThreadMarkdown({
      bac_id: 'bac_t',
      revision: 'rev',
      title: 'X',
    });
    expect(md).not.toContain('provider:');
    expect(md).not.toContain('url:');
    expect(md).not.toContain('status:');
    expect(md).not.toContain('workstream:');
    expect(md).not.toContain('lastResearchMode:');
  });

  it('renders lastResearchMode in the frontmatter when set', () => {
    const md = renderThreadMarkdown({
      bac_id: 'bac_t',
      revision: 'rev',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/abc',
      title: 'Switchboard',
      status: 'active',
      lastResearchMode: 'deep-research',
    });
    expect(md).toContain('lastResearchMode: deep-research');
  });
});

describe('renderPromotedThreadMarkdown', () => {
  it('renders promoted metadata and captured turns in ordinal order', () => {
    const md = renderPromotedThreadMarkdown(
      {
        bac_id: 'bac_t',
        revision: 'rev',
        title: 'Migration thread',
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/migration',
        primaryWorkstreamId: 'bac_ws',
      },
      [
        {
          role: 'assistant',
          text: 'Use a checkpoint.',
          ordinal: 1,
          capturedAt: '2026-04-30T10:01:00.000Z',
        },
        {
          role: 'user',
          text: 'How should we migrate?',
          ordinal: 0,
          capturedAt: '2026-04-30T10:00:00.000Z',
        },
      ],
      'M2 polish',
      '2026-04-30T11:00:00.000Z',
    );

    expect(md).toContain('Promoted to M2 polish on 2026-04-30.');
    expect(md.indexOf('### User')).toBeLessThan(md.indexOf('### Assistant'));
    expect(md).toContain('How should we migrate?');
    expect(md).toContain('Use a checkpoint.');
    expect(md).toContain('turns: 2');
    expect(md).toContain('bac_locked: true');
  });

  it('ellipsises long turn bodies because full text stays in the ledger', () => {
    const md = renderPromotedThreadMarkdown(
      { bac_id: 'bac_t', revision: 'rev', title: 'Long' },
      [
        {
          role: 'user',
          text: 'x'.repeat(2100),
          ordinal: 0,
          capturedAt: '2026-04-30T10:00:00.000Z',
        },
      ],
      'M2 polish',
      '2026-04-30T11:00:00.000Z',
    );

    expect(md).toContain('[...]');
    expect(md.length).toBeLessThan(2400);
  });
});

describe('parseMarkdownLockSentinel', () => {
  it('detects bac_locked: true in YAML frontmatter', () => {
    expect(parseMarkdownLockSentinel('---\nbac_locked: true\ntitle: X\n---\n# X\n')).toBe(true);
    expect(parseMarkdownLockSentinel('---\nbac_locked: "true"\n---\n# X\n')).toBe(true);
  });

  it('ignores body text and non-true values', () => {
    expect(parseMarkdownLockSentinel('---\nbac_locked: false\n---\nbac_locked: true\n')).toBe(
      false,
    );
    expect(parseMarkdownLockSentinel('# no frontmatter\nbac_locked: true\n')).toBe(false);
  });
});
