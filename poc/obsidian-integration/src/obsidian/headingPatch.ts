const normalizeHeading = (heading: string): string =>
  heading.replace(/^#+\s*/u, '').trim().toLowerCase();

export const appendUnderHeading = (
  markdown: string,
  heading: string,
  appendText: string,
): string => {
  const lines = markdown.split(/\r?\n/u);
  const target = normalizeHeading(heading);
  const headingIndex = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    return match ? normalizeHeading(match[2] ?? '') === target : false;
  });
  const cleanAppend = appendText.trimEnd();

  if (headingIndex === -1) {
    const prefix = markdown.endsWith('\n') ? markdown.trimEnd() : markdown;
    return `${prefix}\n\n## ${heading.replace(/^#+\s*/u, '').trim()}\n\n${cleanAppend}\n`;
  }

  const headingLevel = (/^(#{1,6})\s/u.exec(lines[headingIndex] ?? '')?.[1] ?? '##').length;
  let insertIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[index] ?? '');
    if (match && (match[1]?.length ?? 0) <= headingLevel) {
      insertIndex = index;
      break;
    }
  }

  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  while (before.length > 0 && before[before.length - 1] === '') {
    before.pop();
  }
  const next = [...before, '', cleanAppend, ''];
  if (after.length > 0) {
    next.push(...after);
  }
  return next.join('\n').replace(/\n{4,}/gu, '\n\n\n');
};
