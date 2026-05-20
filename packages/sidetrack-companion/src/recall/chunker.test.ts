import { describe, expect, it } from 'vitest';

import { chunkTurn, type RecallChunkInput } from './chunker.js';

const baseInput = (overrides: Partial<RecallChunkInput>): RecallChunkInput => ({
  sourceBacId: 'bac_test',
  threadId: 'thread_test',
  provider: 'chatgpt',
  threadUrl: 'https://chatgpt.com/c/test',
  title: 'Test thread',
  role: 'assistant',
  turnOrdinal: 0,
  modelName: 'gpt-5-thinking',
  capturedAt: '2026-05-06T18:00:00.000Z',
  text: '',
  ...overrides,
});

describe('chunker', () => {
  it('chunks a heading-structured deep-research report so each chunk owns its breadcrumb', () => {
    const markdown = `Preamble paragraph that introduces the report and gives context. ${'abc '.repeat(60)}

## 1. Plugin / extension behavior

Body paragraph for section 1 — some content discussing plugin behavior in detail. ${'def '.repeat(60)}

## 2. Companion behavior

Body paragraph for section 2 — content about the companion runtime and replicas. ${'ghi '.repeat(60)}

### 2.1 Sub-detail

Sub-detail content here. ${'jkl '.repeat(40)}`;
    const chunks = chunkTurn(baseInput({ markdown }));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const sectionTwoChunk = chunks.find((c) => c.text.includes('Body paragraph for section 2'));
    expect(sectionTwoChunk?.headingPath).toEqual(['2. Companion behavior']);
    const subDetail = chunks.find((c) => c.text.includes('Sub-detail content'));
    expect(subDetail?.headingPath).toEqual(['2. Companion behavior', '2.1 Sub-detail']);
    // Heading breadcrumb prepended to the embedder text but not the
    // raw text.
    expect(sectionTwoChunk?.embedText.startsWith('2. Companion behavior')).toBe(true);
    expect(sectionTwoChunk?.text.startsWith('2. Companion behavior')).toBe(false);
  });

  it('keeps fenced code blocks intact (never splits mid-fence)', () => {
    const markdown = `Some prose before the code.

\`\`\`ts
const a = 1;
const b = 2;
function compute(x: number) {
  return x + a + b;
}
// padding
${'// noise\n'.repeat(60)}
\`\`\`

Some prose after the code.`;
    const chunks = chunkTurn(baseInput({ markdown }));
    const fenceChunk = chunks.find((c) => c.text.includes('```ts'));
    expect(fenceChunk).toBeDefined();
    // Closing fence stays in the same chunk.
    expect(fenceChunk?.text.match(/```/g)?.length).toBe(2);
  });

  it('produces deterministic chunkIds — same input twice → same ids in same order', () => {
    const markdown = `# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Sub\n\nThird paragraph.`;
    const a = chunkTurn(baseInput({ markdown }));
    const b = chunkTurn(baseInput({ markdown }));
    expect(a.map((c) => c.chunkId)).toEqual(b.map((c) => c.chunkId));
  });

  it('splits an over-long paragraph on sentence boundaries (length cap holds)', () => {
    const sentence = 'This is a sentence that ends with a period. ';
    const long = sentence.repeat(120); // ~5 KB single paragraph
    const chunks = chunkTurn(baseInput({ text: long }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(2500);
    }
  });

  it('splits an over-long fenced code block into multiple chunks at line boundaries (no truncation)', () => {
    // Single fence with ~6 KB of body — well over HARD_CAP_CHARS.
    const lines = Array.from({ length: 200 }, (_, i) => `// line ${String(i)} ${'x'.repeat(20)}`);
    const fence = ['```ts', ...lines, '```'].join('\n');
    const chunks = chunkTurn(baseInput({ markdown: fence }));
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk is a valid fence — opens with ```ts (lang
    // preserved) and ends with the closing ``` so downstream
    // readers see structurally-coherent code.
    for (const chunk of chunks) {
      expect(chunk.text.match(/```/g)?.length).toBe(2);
      expect(chunk.text.startsWith('```ts')).toBe(true);
    }
    // No body line is silently dropped: every original `// line N`
    // appears in at least one chunk.
    const concatenated = chunks.map((c) => c.text).join('\n');
    expect(concatenated).toContain('// line 0 ');
    expect(concatenated).toContain('// line 199 ');
  });

  it('drops empty / whitespace-only inputs', () => {
    expect(chunkTurn(baseInput({ text: '' }))).toEqual([]);
    expect(chunkTurn(baseInput({ text: '   \n\n   ' }))).toEqual([]);
  });

  it('preserves source metadata on every chunk and ascends turn ordinals', () => {
    const markdown = `# H\n\nP1 content here. ${'a '.repeat(80)}\n\n## H2\n\nP2 content.\n`;
    const chunks = chunkTurn(
      baseInput({
        markdown,
        turnOrdinal: 7,
        provider: 'gemini',
        title: 'Custom title',
      }),
    );
    for (const c of chunks) {
      expect(c.turnOrdinal).toBe(7);
      expect(c.provider).toBe('gemini');
      expect(c.title).toBe('Custom title');
      expect(c.threadId).toBe('thread_test');
      expect(c.sourceBacId).toBe('bac_test');
      expect(typeof c.textHash).toBe('string');
      expect(c.textHash.length).toBe(64);
    }
  });

  it('prefers markdown over formattedText over plain text when all are comparably complete', () => {
    // Three sources of comparable length — markdown's structure
    // (headings, fences) wins so chunk boundaries respect them.
    const md = '# Heading\n\nFrom markdown content roughly matching text length.';
    const fmt = 'From formatted content roughly matching text length.';
    const txt = 'From text only roughly matching the same length.';
    const a = chunkTurn(baseInput({ markdown: md, formattedText: fmt, text: txt }));
    expect(a[0]?.text).toContain('From markdown');
    const b = chunkTurn(baseInput({ formattedText: fmt, text: txt }));
    expect(b[0]?.text).toContain('From formatted');
    const c = chunkTurn(baseInput({ text: 'From text only' }));
    expect(c[0]?.text).toContain('From text only');
  });

  it('skips a truncated markdown — falls back to text when markdown is much shorter than text', () => {
    // The upstream extractor's mergeAdjacentTurns shallow-copies the
    // FIRST block's element ref into the merged turn, so enrichTurn
    // produces a `markdown` reflecting only that first block — a
    // 73-char head for a turn whose `text` is 8586 chars (the actual
    // dogfood case, 2026-05-20). Without this gate the chunker would
    // index ONLY the 73c head and silently drop the entire tail
    // (Jepsen, scenario nemesis, 9-state verdict — all gone from
    // recall search). Defensive completeness threshold (≥ 50% of
    // text length): markdown that fails to meet it gets shadowed.
    const tailMarker = 'TAIL_UNIQUE_TOKEN';
    const truncatedMd = '我会先看 repo 的 README/目录结构';
    const fullText = `${truncatedMd}。${'又是一段中文 '.repeat(80)} ${tailMarker} ${'更多段落 '.repeat(80)}`;
    const result = chunkTurn(
      baseInput({
        markdown: truncatedMd, // suspiciously short — would shadow the tail
        text: fullText,
      }),
    );
    // The tail unique marker must appear in some chunk — proving the
    // chunker fell back to text instead of being misled by markdown.
    const allChunkText = result.map((c) => c.text).join('\n');
    expect(allChunkText).toContain(tailMarker);
  });

  it('still prefers markdown when it is comparably complete (heading structure preserved)', () => {
    // A markdown that's longer than text (heading + body) — still
    // counts as complete, so markdown's structure (heading
    // breadcrumbs) populates headingPath. Confirms the gate only
    // shadows TRUNCATED markdown, not the normal case.
    const text = `Paragraph one ${'word '.repeat(50)}\n\nParagraph two ${'word '.repeat(50)}`;
    const md = `# Section heading\n\n${text}`;
    const result = chunkTurn(baseInput({ markdown: md, text }));
    // Heading from markdown lands in headingPath (chunker extracts
    // headings as breadcrumbs separate from chunk body).
    expect(result[0]?.headingPath).toContain('Section heading');
  });
});
