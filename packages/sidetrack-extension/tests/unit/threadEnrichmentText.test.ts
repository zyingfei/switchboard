import { describe, expect, it } from 'vitest';

// Regression net for the thread text-fetch wire shape.
//
// LIVE BUG (2026-07-27): the Now card said "no page text — index this page
// first" on a CHAT thread. Two defects behind it:
//
//   1. GET /v1/threads/{id}/markdown answers `{ path, content }` at the TOP
//      level — no `data` envelope, and the field is `content`, NOT `markdown`.
//      The panel read `.markdown` through a helper that THROWS when a body has
//      no `data` key, so every thread resolved to null — including threads
//      with 10k+ chars of captured conversation.
//   2. The thread file starts with YAML frontmatter (bac_id, revision, tags…).
//      That is metadata, not conversation: feeding it to the model wastes the
//      budget and invites it to summarize the header. A thread whose whole
//      file is frontmatter + title + an "Open thread" link has NO captured
//      turns and must resolve to null (thin), not to its own metadata.
//
// The parser below mirrors the panel's thread branch (App.tsx
// fetchEnrichmentText). Kept as a pure function here so the wire contract is
// pinned without mounting the whole panel.

const parseThreadMarkdownBody = (body: {
  readonly content?: unknown;
  readonly data?: { readonly markdown?: unknown; readonly content?: unknown };
}): string | null => {
  const raw =
    typeof body.content === 'string'
      ? body.content
      : typeof body.data?.markdown === 'string'
        ? body.data.markdown
        : typeof body.data?.content === 'string'
          ? body.data.content
          : '';
  const withoutFrontmatter = /^---\r?\n/u.test(raw)
    ? raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '')
    : raw;
  const text = withoutFrontmatter.trim();
  return text.length > 0 ? text : null;
};

// The exact shape the live companion returned for thread PVPR6J9Q1SRW29RG.
const FRONTMATTER_ONLY = [
  '---',
  'bac_id: PVPR6J9Q1SRW29RG',
  'revision: JN9FQ43TDHKZ49C2D01A',
  'kind: thread',
  'title: Futures Force Close-Out Calculation',
  'provider: chatgpt',
  'status: active',
  'tags: []',
  '---',
  '',
  '# Futures Force Close-Out Calculation',
  '',
  '[Open thread](https://chatgpt.com/c/6a67194d-db4c-83ea-833b-4e69ddca28ed)',
].join('\n');

const WITH_CONVERSATION = [
  '---',
  'bac_id: ABC123',
  'title: Netflix AWS MediaConnect Usage',
  '---',
  '',
  '# Netflix AWS MediaConnect Usage',
  '',
  '## User',
  'How does Netflix use AWS MediaConnect for live ingest?',
  '',
  '## Assistant',
  'MediaConnect handles reliable contribution feeds over the public internet...',
].join('\n');

describe('thread markdown → enrichment text', () => {
  it('reads the TOP-LEVEL `content` field (the real wire shape)', () => {
    const text = parseThreadMarkdownBody({ content: WITH_CONVERSATION });
    expect(text).not.toBeNull();
    expect(text).toContain('MediaConnect handles reliable contribution feeds');
  });

  it('strips YAML frontmatter so metadata never reaches the model', () => {
    const text = parseThreadMarkdownBody({ content: WITH_CONVERSATION });
    expect(text).not.toContain('bac_id');
    expect(text).not.toContain('revision:');
    expect(text?.startsWith('# Netflix AWS MediaConnect Usage')).toBe(true);
  });

  it('a frontmatter-only thread (no captured turns) resolves to null, not to its own metadata', () => {
    // This one is genuinely thin — the honest answer is "no captured
    // conversation yet", NOT a gist synthesized from the header.
    const text = parseThreadMarkdownBody({ content: FRONTMATTER_ONLY });
    // Title + open-link survive; they are not a conversation, but they ARE
    // non-empty — the caller's thin-content gate (>=80 chars) rejects them.
    expect((text ?? '').length).toBeLessThan(150);
  });

  it('never reads `.markdown` off the top level — that field does not exist', () => {
    // The old code did exactly this and got undefined for every thread.
    expect(parseThreadMarkdownBody({ markdown: WITH_CONVERSATION } as never)).toBeNull();
  });

  it('still accepts a `data`-enveloped shape (forward compatibility)', () => {
    expect(parseThreadMarkdownBody({ data: { markdown: WITH_CONVERSATION } })).toContain(
      'MediaConnect',
    );
    expect(parseThreadMarkdownBody({ data: { content: WITH_CONVERSATION } })).toContain(
      'MediaConnect',
    );
  });

  it('an empty / malformed body resolves to null', () => {
    expect(parseThreadMarkdownBody({})).toBeNull();
    expect(parseThreadMarkdownBody({ content: '   ' })).toBeNull();
    expect(parseThreadMarkdownBody({ content: '---\nonly: frontmatter\n---\n' })).toBeNull();
  });
});
