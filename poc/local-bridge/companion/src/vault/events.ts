import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { dateKey } from '../model';

export const eventLogPath = (vaultPath: string, date = new Date()): string =>
  path.join(vaultPath, '_BAC', 'events', `${dateKey(date)}.jsonl`);

export const appendJsonLine = async (filePath: string, value: unknown): Promise<number> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  const file = await open(filePath, 'a');
  try {
    await file.writeFile(line, 'utf8');
  } finally {
    await file.close();
  }
  return Buffer.byteLength(line, 'utf8');
};

export const appendBridgeEvent = async (
  vaultPath: string,
  event: unknown,
): Promise<{ readonly path: string; readonly bytes: number }> => {
  const filePath = eventLogPath(vaultPath);
  const bytes = await appendJsonLine(filePath, event);
  return {
    path: path.relative(vaultPath, filePath).replaceAll(path.sep, '/'),
    bytes,
  };
};
