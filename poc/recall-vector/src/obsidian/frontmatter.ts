import type { FrontmatterValue } from './model';

export type FrontmatterRecord = Record<string, FrontmatterValue>;

interface FrontmatterBlock {
  yaml: string;
  body: string;
  hasBlock: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

const splitFrontmatter = (markdown: string): FrontmatterBlock => {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    return {
      yaml: '',
      body: markdown,
      hasBlock: false,
    };
  }
  return {
    yaml: match[1] ?? '',
    body: markdown.slice(match[0].length),
    hasBlock: true,
  };
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseScalar = (value: string): FrontmatterValue => {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.startsWith('[[')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  }
  const raw = unquote(trimmed);
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(raw)) {
    return Number(raw);
  }
  return raw;
};

export const parseFrontmatter = (markdown: string): FrontmatterRecord => {
  const { yaml } = splitFrontmatter(markdown);
  const lines = yaml.split(/\r?\n/u);
  const record: FrontmatterRecord = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/u.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1] ?? '';
    const rest = match[2] ?? '';
    const list: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const itemMatch = /^\s*-\s+(.*)$/u.exec(lines[cursor] ?? '');
      if (!itemMatch) {
        break;
      }
      list.push(String(parseScalar(itemMatch[1] ?? '')));
      cursor += 1;
    }
    if (list.length > 0 && rest === '') {
      record[key] = list;
      index = cursor - 1;
      continue;
    }
    record[key] = parseScalar(rest);
  }

  return record;
};

export const stripFrontmatter = (markdown: string): string => splitFrontmatter(markdown).body;

export const getFrontmatterString = (markdown: string, key: string): string | undefined => {
  const value = parseFrontmatter(markdown)[key];
  return typeof value === 'string' ? value : undefined;
};
