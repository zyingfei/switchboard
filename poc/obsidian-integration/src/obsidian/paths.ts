export const sanitizeFileName = (title: string): string => {
  const sanitized = title
    .replace(/[\\/:*?"<>|#^[\]]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return sanitized || 'Untitled';
};

export const dateFolder = (iso: string): string => iso.slice(0, 10);

export const buildInboxPath = (iso: string, title: string): string =>
  `_BAC/inbox/${dateFolder(iso)}/${sanitizeFileName(title)}.md`;

export const buildProjectPath = (project: string, title: string): string =>
  `Projects/${sanitizeFileName(project)}/${sanitizeFileName(title)}.md`;

export const markdownPath = (path: string): boolean => path.toLowerCase().endsWith('.md');
