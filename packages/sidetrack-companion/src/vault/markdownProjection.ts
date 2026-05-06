// Markdown projection of vault records (PRD §10 Case A, first slice).
//
// The vault's source of truth stays JSON for machine read/write, but
// every workstream + thread also gets a sidecar `.md` with a YAML
// frontmatter header so a human can browse the vault in Obsidian /
// VSCode / GitHub without parsing JSON.
//
// Pure functions: take the record in, return a string. The writer
// (writer.ts) is responsible for the actual fs.writeFile call. Tests
// can lock down the format without touching disk.
//
// The .canvas / .base (Obsidian-specific) projections come in a
// follow-up PR; this slice covers the universally useful Markdown
// path so external editors can render Sidetrack vaults today.

const escapeYamlValue = (value: string): string => {
  // Quote if the value contains characters that YAML 1.2 would
  // interpret specially (`:` `#` `&` `*` `[` `]` `{` `}` `|` `>` `'`
  // `"` `%` `!` `@`, leading whitespace, or starts with - / ? at the
  // start). Strings without those characters can stay bare.
  const needsQuoting = /[:#&*[\]{}|>'"%!@`]|^\s|\s$|^[-?]|^$/.test(value);
  if (!needsQuoting) {
    return value;
  }
  // Always use double quotes; escape backslashes + double quotes.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

type FrontmatterScalar = string | number | boolean | undefined | null;
type FrontmatterValue = FrontmatterScalar | readonly FrontmatterScalar[];

const isReadonlyArray = (value: unknown): value is readonly FrontmatterScalar[] =>
  Array.isArray(value);

const renderYamlFrontmatter = (
  fields: readonly (readonly [string, FrontmatterValue])[],
): string => {
  const lines: string[] = ['---'];
  for (const [key, value] of fields) {
    if (value === undefined || value === null) {
      continue;
    }
    if (isReadonlyArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        lines.push(`  - ${escapeYamlValue(String(item))}`);
      }
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    lines.push(`${key}: ${escapeYamlValue(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
};

export interface WorkstreamProjectionInput {
  readonly bac_id: string;
  readonly revision: string;
  readonly title?: string;
  readonly parentId?: string;
  readonly children?: readonly string[];
  readonly tags?: readonly string[];
  readonly privacy?: 'private' | 'shared' | 'public';
  readonly screenShareSensitive?: boolean;
  readonly checklist?: readonly { readonly text: string; readonly checked: boolean }[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export const renderWorkstreamMarkdown = (input: WorkstreamProjectionInput): string => {
  const frontmatter = renderYamlFrontmatter([
    ['bac_id', input.bac_id],
    ['revision', input.revision],
    ['kind', 'workstream'],
    ['title', input.title ?? input.bac_id],
    ['privacy', input.privacy ?? 'shared'],
    ['screenShareSensitive', input.screenShareSensitive ?? false],
    ['parent', input.parentId],
    ['tags', input.tags ?? []],
    ['createdAt', input.createdAt],
    ['updatedAt', input.updatedAt],
  ]);
  const sections: string[] = [];
  sections.push(`# ${input.title ?? input.bac_id}`);

  const children = input.children ?? [];
  if (children.length > 0) {
    sections.push('', '## Child workstreams');
    for (const child of children) {
      sections.push(`- [[${child}]]`);
    }
  }

  const checklist = input.checklist ?? [];
  if (checklist.length > 0) {
    sections.push('', '## Checklist');
    for (const item of checklist) {
      const marker = item.checked ? 'x' : ' ';
      sections.push(`- [${marker}] ${item.text}`);
    }
  }

  return `${frontmatter}${sections.join('\n')}\n`;
};

export interface ThreadProjectionInput {
  readonly bac_id: string;
  readonly revision: string;
  readonly provider?: string;
  readonly threadUrl?: string;
  readonly title?: string;
  readonly status?: string;
  readonly trackingMode?: string;
  readonly primaryWorkstreamId?: string;
  readonly tags?: readonly string[];
  readonly lastSeenAt?: string;
  readonly lastTurnRole?: string;
  readonly lastResearchMode?: string;
  readonly parentThreadId?: string;
  readonly updatedAt?: string;
}

export interface ThreadTurnProjectionInput {
  readonly role: 'user' | 'assistant' | 'system' | 'unknown';
  readonly text: string;
  readonly ordinal: number;
  readonly capturedAt: string;
}

export const renderThreadMarkdown = (input: ThreadProjectionInput): string => {
  const frontmatter = renderYamlFrontmatter([
    ['bac_id', input.bac_id],
    ['revision', input.revision],
    ['kind', 'thread'],
    ['title', input.title ?? input.threadUrl ?? input.bac_id],
    ['provider', input.provider],
    ['url', input.threadUrl],
    ['status', input.status],
    ['trackingMode', input.trackingMode],
    ['workstream', input.primaryWorkstreamId],
    ['parentThread', input.parentThreadId],
    ['lastTurnRole', input.lastTurnRole],
    ['lastResearchMode', input.lastResearchMode],
    ['lastSeenAt', input.lastSeenAt],
    ['tags', input.tags ?? []],
    ['updatedAt', input.updatedAt],
  ]);
  const sections: string[] = [];
  sections.push(`# ${input.title ?? input.bac_id}`);
  if (input.threadUrl !== undefined) {
    sections.push('', `[Open thread](${input.threadUrl})`);
  }
  if (input.primaryWorkstreamId !== undefined) {
    sections.push('', `Workstream: [[${input.primaryWorkstreamId}]]`);
  }
  return `${frontmatter}${sections.join('\n')}\n`;
};

const ellipsizeTurnText = (value: string, maxChars = 2000): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars).trimEnd()}\n\n[...]`;
};

const turnHeading = (role: ThreadTurnProjectionInput['role']): string => {
  if (role === 'user') {
    return 'User';
  }
  if (role === 'assistant') {
    return 'Assistant';
  }
  if (role === 'system') {
    return 'System';
  }
  return 'Unknown';
};

export const parseMarkdownLockSentinel = (content: string): boolean => {
  if (!content.startsWith('---\n')) {
    return false;
  }

  const frontmatterEnd = content.indexOf('\n---', 4);
  if (frontmatterEnd === -1) {
    return false;
  }

  const frontmatter = content.slice(4, frontmatterEnd);
  return frontmatter
    .split('\n')
    .some((line) => /^bac_locked:\s*(true|"true"|'true')\s*$/iu.test(line.trim()));
};

export const renderPromotedThreadMarkdown = (
  thread: ThreadProjectionInput,
  turns: readonly ThreadTurnProjectionInput[],
  workstreamTitle: string,
  generatedAt = new Date().toISOString(),
): string => {
  const base = renderThreadMarkdown(thread).trimEnd();
  const lines: string[] = [
    base,
    '',
    `Promoted to ${workstreamTitle} on ${generatedAt.slice(0, 10)}.`,
  ];

  if (turns.length > 0) {
    lines.push('', '## Captured turns');
    for (const turn of [...turns].sort((left, right) => left.ordinal - right.ordinal)) {
      lines.push('', `### ${turnHeading(turn.role)}`, '', ellipsizeTurnText(turn.text));
    }
  }

  lines.push(
    '',
    `_Generated by Sidetrack on ${generatedAt}; turns: ${String(turns.length)}. Edit this file to override the auto-projection — Sidetrack will not overwrite a hand-edited file (sentinel: bac_locked: true in frontmatter)._`,
    '',
  );
  return lines.join('\n');
};
