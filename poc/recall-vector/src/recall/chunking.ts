import { hashText } from './hash';
import type { RecallChunk, RecallDocument } from './model';

export interface ChunkingOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 720;

const normalizeParagraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/gu)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);

const splitLongParagraph = (paragraph: string, maxChars: number): string[] => {
  if (paragraph.length <= maxChars) {
    return [paragraph];
  }

  const sentences = paragraph.match(/[^.!?]+[.!?]*/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length === 0) {
    return paragraph.match(new RegExp(`.{1,${maxChars}}`, 'gu')) ?? [paragraph];
  }

  const segments: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) {
      segments.push(current);
    }
    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }
    const words = sentence.split(/\s+/u);
    let wordWindow = '';
    for (const word of words) {
      const nextWordWindow = wordWindow ? `${wordWindow} ${word}` : word;
      if (nextWordWindow.length <= maxChars) {
        wordWindow = nextWordWindow;
        continue;
      }
      if (wordWindow) {
        segments.push(wordWindow);
      }
      wordWindow = word;
    }
    current = wordWindow;
  }
  if (current) {
    segments.push(current);
  }
  return segments;
};

export const chunkDocument = (
  document: RecallDocument,
  options: ChunkingOptions = {},
): RecallChunk[] => {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const paragraphs = normalizeParagraphs(document.text).flatMap((paragraph) =>
    splitLongParagraph(paragraph, maxChars),
  );
  const chunks: RecallChunk[] = [];
  let current = '';
  let chunkIndex = 0;

  const flush = (): void => {
    const text = current.trim();
    if (!text) {
      return;
    }
    const digest = hashText(text);
    chunks.push({
      id: `${document.id}:${chunkIndex}`,
      digest,
      sourceId: document.id,
      sourcePath: document.sourcePath,
      sourceKind: document.sourceKind,
      title: document.title,
      text,
      capturedAt: document.capturedAt,
      chunkIndex,
    });
    chunkIndex += 1;
    current = '';
  };

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    flush();
    current = paragraph;
  }
  flush();
  return chunks;
};
