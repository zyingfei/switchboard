const TIMESTAMP_LINE = /^\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\s*$/u;
const STRIPPED_PREFIX_LINE = /^\s*(?:#|\/\/|>)\s?.*$/u;

export const normalizeSelectionText = (input: string): string => {
  const withoutSetextHeader = input.replace(/^[A-Za-z\s]+\n=+\n/u, '');
  const lines = withoutSetextHeader
    .split(/\r?\n/u)
    .filter((line) => !TIMESTAMP_LINE.test(line))
    .filter((line) => !STRIPPED_PREFIX_LINE.test(line));
  return lines.join('\n').replace(/\s+/gu, ' ').trim();
};
