import { serializeFrontmatter } from './frontmatter';
import type { BacThreadRecord, FrontmatterValue } from './model';

export interface BuildThreadNoteInput {
  bacId: string;
  title: string;
  provider: string;
  sourceUrl: string;
  status: string;
  project: string;
  topic: string;
  tags: string[];
  related: string[];
  createdAt: string;
}

export const buildThreadNote = ({
  bacId,
  title,
  provider,
  sourceUrl,
  status,
  project,
  topic,
  tags,
  related,
  createdAt,
}: BuildThreadNoteInput): string => {
  const frontmatter: Record<string, FrontmatterValue> = {
    bac_id: bacId,
    bac_type: 'thread',
    title,
    provider,
    source_url: sourceUrl,
    status,
    project,
    topic,
    tags,
    related,
    created: createdAt.slice(0, 10),
  };

  return `${serializeFrontmatter(frontmatter)}# ${title}

Synthetic capture used by the Obsidian integration POC.

## Notes

- Initial capture landed in the BAC inbox.

## Source

${sourceUrl}

## Untouched Section

This section must survive heading-target PATCHes unchanged.
`;
};

export const threadRecordTitle = (record: BacThreadRecord): string =>
  `${record.title} (${record.provider}, ${record.status})`;
