import { dateKey, toJsonLine } from '../shared/jsonl';

export const WRITE_STRATEGY = 'fsa-createWritable-keepExistingData-seek-close';

const encoder = new TextEncoder();

const directory = async (
  root: FileSystemDirectoryHandle,
  segments: readonly string[],
): Promise<FileSystemDirectoryHandle> => {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
};

export const queryReadWritePermission = async (
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState | 'unavailable'> => {
  if (typeof handle.queryPermission !== 'function') {
    return 'unavailable';
  }
  return await handle.queryPermission({ mode: 'readwrite' });
};

export const requestReadWritePermission = async (
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState | 'unavailable'> => {
  if (typeof handle.requestPermission !== 'function') {
    return 'unavailable';
  }
  return await handle.requestPermission({ mode: 'readwrite' });
};

export const appendJsonLine = async (
  root: FileSystemDirectoryHandle,
  directorySegments: readonly string[],
  fileName: string,
  value: unknown,
): Promise<{
  readonly path: string;
  readonly bytes: number;
  readonly strategy: string;
}> => {
  const parent = await directory(root, directorySegments);
  const fileHandle = await parent.getFileHandle(fileName, { create: true });
  const line = toJsonLine(value);
  const existing = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.seek(existing.size);
  await writable.write(line);
  await writable.close();

  return {
    path: [...directorySegments, fileName].join('/'),
    bytes: encoder.encode(line).byteLength,
    strategy: WRITE_STRATEGY,
  };
};

export const eventLogName = (date = new Date()): string => `${dateKey(date)}.jsonl`;
