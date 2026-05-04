import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  settingsBundleSchema,
  type ConflictRecord,
  type SettingsBundle,
  type TemplateRecord,
  type WorkstreamRecord,
} from './schemas.js';

export interface ImportResult {
  readonly applied: number;
  readonly skipped: number;
  readonly conflicts: readonly ConflictRecord[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const importRecords = async (
  root: string,
  kind: ConflictRecord['kind'],
  records: readonly (WorkstreamRecord | TemplateRecord)[],
): Promise<{ readonly applied: number; readonly conflicts: readonly ConflictRecord[] }> => {
  let applied = 0;
  const conflicts: ConflictRecord[] = [];
  for (const record of records) {
    const path = join(root, `${record.bac_id}.json`);
    if (await exists(path)) {
      conflicts.push({ kind, bac_id: record.bac_id, reason: 'already_exists' });
      continue;
    }
    await writeJson(path, record);
    applied += 1;
  }
  return { applied, conflicts };
};

export const importSettings = async (
  vaultRoot: string,
  input: unknown,
): Promise<ImportResult> => {
  const bundle: SettingsBundle = settingsBundleSchema.parse(input);
  let applied = 0;
  const conflicts: ConflictRecord[] = [];

  await writeJson(join(vaultRoot, '_BAC', '.config', 'settings.json'), bundle.settings);
  applied += 1;

  const workstreams = await importRecords(
    join(vaultRoot, '_BAC', 'workstreams'),
    'workstream',
    bundle.workstreams,
  );
  applied += workstreams.applied;
  conflicts.push(...workstreams.conflicts);

  const templates = await importRecords(
    join(vaultRoot, '_BAC', 'templates'),
    'template',
    bundle.templates,
  );
  applied += templates.applied;
  conflicts.push(...templates.conflicts);

  return { applied, skipped: conflicts.length, conflicts };
};
