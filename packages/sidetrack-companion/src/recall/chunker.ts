import { createHash } from 'node:crypto';

// Recall V3 chunker. Heading-aware paragraph chunking for captured
// turns. Long deep-research answers are split into ~800-1500 char
// chunks bounded by paragraph + heading + fenced-code-block
// boundaries so the embedder + lexical index see coherent fragments
// rather than truncated mid-sentence text.
//
// The chunker is deterministic: same input always produces same
// chunkIds and same chunk boundaries. PR #93's deterministic-build
// invariant (rebuild is byte-identical given a fixed merged log)
// continues to hold because chunkIds incorporate sourceBacId,
// turnOrdinal, paragraphIndex, and a sha256 of the chunk text.

export interface RecallChunkInput {
  readonly sourceBacId: string;
  readonly threadId: string;
  readonly provider?: string;
  readonly threadUrl?: string;
  readonly title?: string;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly turnOrdinal: number;
  readonly modelName?: string;
  readonly capturedAt: string;
  readonly text: string;
  readonly markdown?: string;
  readonly formattedText?: string;
  // Optional page-content quality tier (high/medium/low) classified
  // upstream by `classifyPageContentQuality`. Carried through to
  // ChunkMetadata so the hybrid ranker can use it as a bounded
  // tiebreak. Optional + omitted-when-absent: chat-turn captures that
  // never go through page-content extraction simply don't set it and
  // the ranker treats them as the neutral tier. NOT part of chunkId
  // or embedText — the deterministic-build invariant is unaffected.
  readonly quality?: 'high' | 'medium' | 'low';
}

export interface RecallChunk {
  readonly chunkId: string;
  readonly sourceBacId: string;
  readonly threadId: string;
  readonly provider?: string;
  readonly threadUrl?: string;
  readonly title?: string;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly turnOrdinal: number;
  readonly modelName?: string;
  readonly capturedAt: string;
  readonly headingPath: readonly string[];
  readonly paragraphIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
  readonly textHash: string;
  // The text actually fed to the embedder. Includes a heading
  // breadcrumb prepended to the raw chunk text so semantic search
  // sees the structural context. Stored separately from `text` so
  // the lexical index ranks against the raw user-visible content.
  readonly embedText: string;
  // Page-content quality tier, passed through verbatim from
  // RecallChunkInput. Absent for chat-turn captures.
  readonly quality?: 'high' | 'medium' | 'low';
}

const TARGET_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 200;
const HARD_CAP_CHARS = 2500;

const sha256Short = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 12);

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

// Pick the richest source representation. Markdown carries heading +
// list + code-fence structure; falls back to formattedText (often a
// pre-rendered plain form) and finally to text.
const pickSource = (input: RecallChunkInput): string => {
  if (typeof input.markdown === 'string' && input.markdown.length > 0) return input.markdown;
  if (typeof input.formattedText === 'string' && input.formattedText.length > 0) {
    return input.formattedText;
  }
  return input.text;
};

interface Block {
  readonly kind: 'heading' | 'fence' | 'paragraph' | 'list' | 'blank';
  readonly text: string;
  readonly headingLevel?: number;
}

// Split a markdown-flavored source into structural blocks. Code
// fences (```) are kept intact — never split mid-fence. Headings
// (#..####) become their own blocks so the chunker can update the
// heading breadcrumb. Everything else is a "paragraph" block.
const splitIntoBlocks = (source: string): readonly Block[] => {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Code fence — slurp until the closing fence (or EOF).
    if (line.startsWith('```')) {
      const start = i;
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        i += 1;
      }
      // Include the closing fence if present.
      if (i < lines.length) i += 1;
      const fenceText = lines.slice(start, i).join('\n');
      blocks.push({ kind: 'fence', text: fenceText });
      continue;
    }
    // Heading.
    const headingMatch = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1]?.length ?? 1;
      blocks.push({ kind: 'heading', text: line, headingLevel: level });
      i += 1;
      continue;
    }
    // Blank line.
    if (line.trim().length === 0) {
      blocks.push({ kind: 'blank', text: '' });
      i += 1;
      continue;
    }
    // Paragraph or list block: gather contiguous non-blank,
    // non-heading, non-fence lines.
    const start = i;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim().length === 0) break;
      if (next.startsWith('```')) break;
      if (/^#{1,4}\s+/.test(next)) break;
      i += 1;
    }
    const para = lines.slice(start, i).join('\n');
    const isList = /^(\s*[-*+]|\s*\d+\.)\s+/.test(para.split('\n')[0] ?? '');
    blocks.push({ kind: isList ? 'list' : 'paragraph', text: para });
  }
  return blocks;
};

// Split an over-long paragraph on sentence-ish boundaries. This is
// called only when a paragraph is too big to fit even one chunk on
// its own. We aim for chunks near TARGET_CHUNK_CHARS and never
// exceed HARD_CAP_CHARS.
const splitLongParagraph = (text: string): readonly string[] => {
  if (text.length <= HARD_CAP_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > TARGET_CHUNK_CHARS && buf.length >= MIN_CHUNK_CHARS) {
      out.push(buf);
      buf = '';
    }
    buf += (buf.length > 0 ? ' ' : '') + s;
  }
  if (buf.length > 0) out.push(buf);
  // If individual sentences are still too large (rare), force-split.
  return out.flatMap((piece) => {
    if (piece.length <= HARD_CAP_CHARS) return [piece];
    const parts: string[] = [];
    let remaining = piece;
    while (remaining.length > HARD_CAP_CHARS) {
      parts.push(remaining.slice(0, HARD_CAP_CHARS));
      remaining = remaining.slice(HARD_CAP_CHARS);
    }
    if (remaining.length > 0) parts.push(remaining);
    return parts;
  });
};

// Split an over-long fenced code block at LINE boundaries instead
// of truncating. Each chunk's first line is the opening fence
// `\`\`\`<lang>`; the lang is preserved so an embedder / lexical
// reader still sees structurally-coherent code. Each chunk's last
// line is the closing `\`\`\``. The total content covered across
// chunks is the full fence body — no silent drops.
const splitLongFence = (text: string): readonly string[] => {
  if (text.length <= HARD_CAP_CHARS) return [text];
  const lines = text.split('\n');
  // Detect the opening fence line so we can reproduce it on each
  // continuation chunk (preserves the language hint for syntax-
  // aware readers + makes each chunk a valid markdown fence).
  const openFence = lines[0] ?? '```';
  const closeFence = '```';
  // Strip the actual closing fence — we'll re-emit it on the last
  // chunk. If there's no trailing fence (malformed input) we still
  // close every chunk so downstream readers don't see open fences.
  const lastIdx = lines.length - 1;
  const hasClosing = (lines[lastIdx] ?? '').startsWith('```');
  const bodyLines = lines.slice(1, hasClosing ? lastIdx : lines.length);

  const out: string[] = [];
  let buf: string[] = [];
  let bufChars = openFence.length + closeFence.length + 2;
  for (const line of bodyLines) {
    const lineChars = line.length + 1;
    if (bufChars + lineChars > HARD_CAP_CHARS && buf.length > 0) {
      out.push([openFence, ...buf, closeFence].join('\n'));
      buf = [];
      bufChars = openFence.length + closeFence.length + 2;
    }
    buf.push(line);
    bufChars += lineChars;
  }
  if (buf.length > 0) {
    out.push([openFence, ...buf, closeFence].join('\n'));
  }
  return out;
};

// The breadcrumb is a sparse stack indexed by heading level. Seeing
// an Hn heading replaces entries at level n and drops everything
// deeper, then appends the new heading at level n. This mirrors how
// markdown documents actually nest — a sibling H2 doesn't sit
// underneath a previous H2; it replaces it.
const updateHeadingStack = (
  stack: ReadonlyMap<number, string>,
  level: number,
  text: string,
): ReadonlyMap<number, string> => {
  const stripped = text.replace(/^#{1,4}\s+/, '').trim();
  const next = new Map<number, string>();
  for (const [key, value] of stack) {
    if (key < level) next.set(key, value);
  }
  next.set(level, stripped);
  return next;
};

const stackToPath = (stack: ReadonlyMap<number, string>): readonly string[] =>
  [...stack.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);

const formatBreadcrumb = (path: readonly string[]): string =>
  path.length === 0 ? '' : `${path.join(' › ')}\n\n`;

export const chunkTurn = (input: RecallChunkInput): readonly RecallChunk[] => {
  const source = pickSource(input);
  if (source.trim().length === 0) return [];
  const blocks = splitIntoBlocks(source);

  const out: RecallChunk[] = [];
  let headingStack: ReadonlyMap<number, string> = new Map();
  let headingPath: readonly string[] = [];
  let buffer: { readonly text: string; readonly path: readonly string[] }[] = [];
  let bufferChars = 0;
  let charCursor = 0;
  let paragraphIndex = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const combined = buffer.map((b) => b.text).join('\n\n');
    const trimmed = combined.trim();
    if (trimmed.length === 0) {
      buffer = [];
      bufferChars = 0;
      return;
    }
    const path = buffer[0]?.path ?? headingPath;
    const charStart = Math.max(0, charCursor - combined.length);
    const charEnd = charCursor;
    // Paragraph index counts each emitted chunk within this turn.
    const idx = paragraphIndex;
    paragraphIndex += 1;
    const breadcrumb = formatBreadcrumb(path);
    const embedText = `${breadcrumb}${trimmed}`;
    const chunkId = `chunk:${input.sourceBacId}:${String(input.turnOrdinal)}:${String(idx)}:${sha256Short(trimmed)}`;
    out.push({
      chunkId,
      sourceBacId: input.sourceBacId,
      threadId: input.threadId,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.threadUrl === undefined ? {} : { threadUrl: input.threadUrl }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.role === undefined ? {} : { role: input.role }),
      turnOrdinal: input.turnOrdinal,
      ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
      capturedAt: input.capturedAt,
      headingPath: path,
      paragraphIndex: idx,
      charStart,
      charEnd,
      text: trimmed,
      textHash: sha256Hex(trimmed),
      embedText,
      ...(input.quality === undefined ? {} : { quality: input.quality }),
    });
    buffer = [];
    bufferChars = 0;
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // Flush any pending content before changing the heading
      // breadcrumb so the new heading owns the next chunk.
      flush();
      headingStack = updateHeadingStack(headingStack, block.headingLevel ?? 1, block.text);
      headingPath = stackToPath(headingStack);
      charCursor += block.text.length + 1;
      continue;
    }
    if (block.kind === 'blank') {
      // Soft separator between paragraphs.
      charCursor += 1;
      continue;
    }
    // Code fences are kept intact — emit as their own chunk if they'd
    // overflow the buffer; otherwise they may stay buffered with
    // surrounding paragraphs. Long fences (> HARD_CAP_CHARS) split
    // at LINE boundaries into multiple chunks rather than truncating
    // — recall search must not silently drop searchable content.
    if (block.kind === 'fence' && block.text.length >= MIN_CHUNK_CHARS) {
      flush();
      const parts = block.text.length > HARD_CAP_CHARS ? splitLongFence(block.text) : [block.text];
      for (const part of parts) {
        const idx = paragraphIndex;
        paragraphIndex += 1;
        const breadcrumb = formatBreadcrumb(headingPath);
        const trimmed = part;
        const charStart = charCursor;
        const charEnd = charCursor + part.length;
        charCursor = charEnd + 1;
        const chunkId = `chunk:${input.sourceBacId}:${String(input.turnOrdinal)}:${String(idx)}:${sha256Short(trimmed)}`;
        out.push({
          chunkId,
          sourceBacId: input.sourceBacId,
          threadId: input.threadId,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.threadUrl === undefined ? {} : { threadUrl: input.threadUrl }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.role === undefined ? {} : { role: input.role }),
          turnOrdinal: input.turnOrdinal,
          ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
          capturedAt: input.capturedAt,
          headingPath,
          paragraphIndex: idx,
          charStart,
          charEnd,
          text: trimmed,
          textHash: sha256Hex(trimmed),
          embedText: `${breadcrumb}${trimmed}`,
        });
      }
      continue;
    }
    // Paragraph / list / small fence — buffer until cap, then flush.
    const blockChars = block.text.length;
    if (bufferChars + blockChars > TARGET_CHUNK_CHARS && bufferChars >= MIN_CHUNK_CHARS) {
      flush();
    }
    if (blockChars > HARD_CAP_CHARS) {
      // Single paragraph too big — split it on sentence boundaries.
      flush();
      const pieces = splitLongParagraph(block.text);
      for (const piece of pieces) {
        buffer.push({ text: piece, path: headingPath });
        bufferChars += piece.length;
        charCursor += piece.length + 1;
        flush();
      }
      continue;
    }
    buffer.push({ text: block.text, path: headingPath });
    bufferChars += blockChars;
    charCursor += blockChars + 1;
  }
  flush();
  return out;
};
