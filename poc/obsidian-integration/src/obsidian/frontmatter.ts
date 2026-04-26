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

const needsQuotes = (value: string): boolean =>
  value === '' ||
  /^[\s]|[\s]$/u.test(value) ||
  /[:#,[\]{}&*!|>'"%@`]/u.test(value) ||
  value === 'true' ||
  value === 'false' ||
  /^-?\d+(?:\.\d+)?$/u.test(value);

const escapeString = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');

const formatScalar = (value: string | number | boolean): string => {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return needsQuotes(value) ? `"${escapeString(value)}"` : value;
};

export const formatFrontmatterValue = (value: FrontmatterValue): string[] => {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ['[]'];
    }
    return ['', ...value.map((item) => `  - ${formatScalar(item)}`)];
  }
  return [formatScalar(value)];
};

export const serializeFrontmatter = (record: FrontmatterRecord): string => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const formatted = formatFrontmatterValue(value);
    const [first, ...rest] = formatted;
    lines.push(`${key}: ${first ?? ''}`.trimEnd());
    lines.push(...rest);
  }
  return ['---', ...lines, '---', ''].join('\n');
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

const keyLineRange = (lines: string[], key: string): [number, number] | null => {
  const start = lines.findIndex((line) => new RegExp(`^${key}:`, 'u').test(line));
  if (start === -1) {
    return null;
  }
  let end = start + 1;
  while (end < lines.length && /^\s*-\s+/u.test(lines[end] ?? '')) {
    end += 1;
  }
  return [start, end];
};

export const setFrontmatterField = (
  markdown: string,
  key: string,
  value: FrontmatterValue,
): string => {
  const block = splitFrontmatter(markdown);
  const lines = block.yaml ? block.yaml.split(/\r?\n/u) : [];
  const formatted = formatFrontmatterValue(value);
  const [first, ...rest] = formatted;
  const replacement = [`${key}: ${first ?? ''}`.trimEnd(), ...rest];
  const range = keyLineRange(lines, key);

  if (range) {
    lines.splice(range[0], range[1] - range[0], ...replacement);
  } else {
    lines.push(...replacement);
  }

  const nextBlock = ['---', ...lines.filter((line, index) => line !== '' || index < lines.length - 1), '---', ''].join('\n');
  return nextBlock + block.body;
};

export const getFrontmatterString = (
  markdown: string,
  key: string,
): string | undefined => {
  const value = parseFrontmatter(markdown)[key];
  return typeof value === 'string' ? value : undefined;
};

export const getFrontmatterStringArray = (
  markdown: string,
  key: string,
): string[] => {
  const value = parseFrontmatter(markdown)[key];
  return Array.isArray(value) ? value : [];
};
