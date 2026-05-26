import { describe, expect, it } from 'vitest';

import { classifyPageKind } from '../../../src/sidepanel/now/pageKind';

describe('classifyPageKind', () => {
  it('returns "unknown" when url is undefined', () => {
    expect(classifyPageKind({ url: undefined })).toBe('unknown');
  });

  it('returns "unknown" for chrome:// / about:blank / file://', () => {
    expect(classifyPageKind({ url: 'chrome://extensions' })).toBe('unknown');
    expect(classifyPageKind({ url: 'about:blank' })).toBe('unknown');
    expect(classifyPageKind({ url: 'file:///tmp/page.html' })).toBe('unknown');
    expect(classifyPageKind({ url: 'devtools://devtools/panel' })).toBe('unknown');
  });

  it('returns "chat" for chatgpt.com / claude.ai / gemini.google.com', () => {
    expect(classifyPageKind({ url: 'https://chatgpt.com/c/abc' })).toBe('chat');
    expect(classifyPageKind({ url: 'https://claude.ai/chat/xyz' })).toBe('chat');
    expect(classifyPageKind({ url: 'https://gemini.google.com/app/123' })).toBe('chat');
    expect(classifyPageKind({ url: 'https://aistudio.google.com/foo' })).toBe('chat');
  });

  it('returns "chat" when isKnownThread is true (even for non-provider URLs)', () => {
    // A custom-provider thread tracked in the user's threads list.
    expect(
      classifyPageKind({ url: 'https://hosted.example.com/conv/abc', isKnownThread: true }),
    ).toBe('chat');
  });

  it('returns "workstream" when attributedWorkstreamId is set', () => {
    expect(
      classifyPageKind({
        url: 'https://example.com/page',
        attributedWorkstreamId: 'bac_workstream_root',
      }),
    ).toBe('workstream');
  });

  it('returns "page" for a generic indexed page', () => {
    expect(classifyPageKind({ url: 'https://news.ycombinator.com/' })).toBe('page');
    expect(classifyPageKind({ url: 'https://example.com/article' })).toBe('page');
  });

  it('prefers "chat" over "workstream" when both signals fire', () => {
    // A ChatGPT thread that's also pinned to a workstream — still a
    // chat surface for Now layout purposes.
    expect(
      classifyPageKind({
        url: 'https://chatgpt.com/c/abc',
        attributedWorkstreamId: 'bac_workstream_root',
      }),
    ).toBe('chat');
  });
});
