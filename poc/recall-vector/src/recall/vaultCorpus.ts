import { getFrontmatterString, parseFrontmatter, stripFrontmatter } from '../obsidian/frontmatter';
import { inferMarkdownTitle, listVaultFilesRecursive } from '../obsidian/vaultScan';
import { hashText } from './hash';
import type { VaultClient } from '../obsidian/model';
import type { RecallDocument } from './model';

const EVENT_LOG_RE = /^_BAC\/events\/.+\.jsonl$/u;
const DATE_RE = /(\d{4}-\d{2}-\d{2})/u;

const compactJson = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const inferCapturedAt = (path: string, candidates: Array<string | undefined>): string => {
  const found = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  if (found) {
    return found;
  }
  const match = DATE_RE.exec(path);
  return match ? `${match[1]}T12:00:00.000Z` : new Date().toISOString();
};

const toMetadata = (record: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, value as string]),
  );

export const readMarkdownRecallDocument = (path: string, markdown: string): RecallDocument | null => {
  const body = stripFrontmatter(markdown).trim();
  if (!body) {
    return null;
  }
  const frontmatter = parseFrontmatter(markdown) as Record<string, unknown>;
  return {
    id: `md:${hashText(`${path}:${body}`)}`,
    sourcePath: path,
    sourceKind: 'markdown',
    title:
      getFrontmatterString(markdown, 'title') ??
      (typeof frontmatter.bac_type === 'string' ? `${frontmatter.bac_type}: ${inferMarkdownTitle(path, markdown)}` : inferMarkdownTitle(path, markdown)),
    text: body,
    capturedAt: inferCapturedAt(path, [
      getFrontmatterString(markdown, 'bac_generated_at'),
      getFrontmatterString(markdown, 'captured_at'),
      getFrontmatterString(markdown, 'created_at'),
      getFrontmatterString(markdown, 'updated_at'),
    ]),
    metadata: toMetadata(frontmatter),
  };
};

export const readEventLogDocuments = (path: string, jsonl: string): RecallDocument[] =>
  jsonl
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line, index) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const capturedAt = inferCapturedAt(path, [typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined]);
        const title = typeof parsed.type === 'string' ? parsed.type : `event-${index + 1}`;
        const summary = [
          `type: ${title}`,
          typeof parsed.entityId === 'string' ? `entity: ${parsed.entityId}` : '',
          parsed.payload !== undefined ? `payload: ${compactJson(parsed.payload)}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return [
          {
            id: `event:${hashText(`${path}:${index}:${line}`)}`,
            sourcePath: `${path}#L${index + 1}`,
            sourceKind: 'event' as const,
            title,
            text: summary,
            capturedAt,
            metadata: toMetadata(parsed),
          },
        ];
      } catch {
        return [];
      }
    });

export const loadVaultCorpus = async (client: VaultClient): Promise<RecallDocument[]> => {
  const files = await listVaultFilesRecursive(client);
  const documents: RecallDocument[] = [];

  for (const file of files) {
    if (file.type !== 'file') {
      continue;
    }
    if (file.path.endsWith('.md')) {
      const markdown = await client.readFile(file.path);
      const document = readMarkdownRecallDocument(file.path, markdown);
      if (document) {
        documents.push(document);
      }
      continue;
    }
    if (EVENT_LOG_RE.test(file.path)) {
      const jsonl = await client.readFile(file.path);
      documents.push(...readEventLogDocuments(file.path, jsonl));
    }
  }

  return documents.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
};
