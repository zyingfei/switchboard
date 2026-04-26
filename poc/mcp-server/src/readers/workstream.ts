import { getFrontmatterString, stripFrontmatter } from '../../../recall-vector/src/obsidian/frontmatter';
import {
  listVaultFilesRecursive,
  queryWhereWasI,
  readThreadRecord,
} from '../../../obsidian-integration/src/obsidian/vaultSync';
import type { WorkstreamEvent, WorkstreamNode } from '../../../dogfood-loop/src/graph/model';
import type {
  BacThreadRecord,
  FrontmatterValue,
  PluginProbe,
} from '../../../obsidian-integration/src/obsidian/model';

const EVENT_LOG_RE = /^_BAC\/events\/.+\.jsonl$/u;

interface VaultReaderClient {
  probe(): Promise<PluginProbe>;
  listFiles(prefix?: string): Promise<Array<{ path: string; type: 'file' | 'folder' }>>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  patchFrontmatter(path: string, key: string, value: FrontmatterValue): Promise<void>;
  patchHeading(path: string, heading: string, markdown: string): Promise<void>;
}

const asIsoString = (value: string | undefined, fallback: string): string => {
  if (!value) {
    return fallback;
  }
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T12:00:00.000Z` : value;
};

const readRecordTimestamp = (record: BacThreadRecord): string =>
  asIsoString(
    getFrontmatterString(record.content, 'bac_generated_at') ??
      getFrontmatterString(record.content, 'updated_at') ??
      getFrontmatterString(record.content, 'created_at') ??
      getFrontmatterString(record.content, 'created'),
    new Date().toISOString(),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toJsonValue = (value: unknown): WorkstreamEvent['payload'] | undefined => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.every((item) => toJsonValue(item) !== undefined)
      ? (value as WorkstreamEvent['payload'])
      : undefined;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) => [key, toJsonValue(item)] as const);
    if (entries.every(([, item]) => item !== undefined)) {
      return Object.fromEntries(entries) as WorkstreamEvent['payload'];
    }
  }
  return undefined;
};

const buildNoteNode = (record: BacThreadRecord): WorkstreamNode => {
  const timestamp = readRecordTimestamp(record);
  return {
    id: `note:${record.bacId}`,
    type: 'note',
    title: record.title,
    content: stripFrontmatter(record.content).trim(),
    url: record.sourceUrl,
    provider: record.provider,
    metadata: {
      bacId: record.bacId,
      path: record.path,
      project: record.project,
      topic: record.topic,
      status: record.status,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const buildSourceNode = (record: BacThreadRecord): WorkstreamNode => {
  const timestamp = readRecordTimestamp(record);
  return {
    id: `vault-source:${record.bacId}`,
    type: 'source',
    title: record.title,
    content: stripFrontmatter(record.content).trim(),
    url: record.sourceUrl,
    provider: record.provider,
    metadata: {
      bacId: record.bacId,
      path: record.path,
      project: record.project,
      topic: record.topic,
      status: record.status,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

export interface VaultWorkstreamSlice {
  readonly currentNote: WorkstreamNode | null;
  readonly relatedSources: WorkstreamNode[];
  readonly events: WorkstreamEvent[];
}

export const loadVaultEvents = async (client: VaultReaderClient): Promise<WorkstreamEvent[]> => {
  const files = await listVaultFilesRecursive(client);
  const events: WorkstreamEvent[] = [];

  for (const file of files) {
    if (file.type !== 'file' || !EVENT_LOG_RE.test(file.path)) {
      continue;
    }
    const jsonl = await client.readFile(file.path);
    for (const [index, line] of jsonl.split(/\r?\n/u).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        events.push({
          id:
            typeof parsed.id === 'string'
              ? parsed.id
              : `event:${file.path}:${index + 1}`,
          type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
          entityId: typeof parsed.entityId === 'string' ? parsed.entityId : undefined,
          payload: toJsonValue(parsed.payload),
          createdAt:
            typeof parsed.createdAt === 'string'
              ? parsed.createdAt
              : new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }
  }

  return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

export const loadVaultWorkstream = async (
  client: VaultReaderClient,
  options: {
    project: string;
    currentNotePath?: string;
  },
): Promise<VaultWorkstreamSlice> => {
  const records = await queryWhereWasI(client, options.project);
  let currentRecord: BacThreadRecord | null = null;

  if (options.currentNotePath) {
    try {
      const markdown = await client.readFile(options.currentNotePath);
      currentRecord = readThreadRecord(options.currentNotePath, markdown);
    } catch {
      currentRecord = null;
    }
  }

  if (!currentRecord) {
    currentRecord = records[0] ?? null;
  }

  const events = await loadVaultEvents(client);

  return {
    currentNote: currentRecord ? buildNoteNode(currentRecord) : null,
    relatedSources: records
      .filter((record) => record.path !== currentRecord?.path)
      .map(buildSourceNode),
    events,
  };
};
