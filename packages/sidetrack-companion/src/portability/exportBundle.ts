import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { settingsDocumentSchema } from '../http/schemas.js';
import {
  settingsBundleSchema,
  templateBundleRecordSchema,
  workstreamBundleRecordSchema,
  type SettingsBundle,
  type TemplateRecord,
  type WorkstreamRecord,
} from './schemas.js';

const readJson = async <TValue>(path: string): Promise<TValue | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as TValue;
  } catch {
    return null;
  }
};

const readRecords = async <TRecord extends { readonly bac_id: string }>(
  root: string,
  parse: (value: unknown) => TRecord | null,
): Promise<readonly TRecord[]> => {
  const names = await readdir(root).catch(() => []);
  const records: TRecord[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
    const parsed = parse(await readJson<unknown>(join(root, name)));
    if (parsed !== null) {
      records.push(parsed);
    }
  }
  return records.sort((left, right) => left.bac_id.localeCompare(right.bac_id));
};

// schemaVersion=1 is the stable portability contract for settings,
// workstream metadata, and dispatch templates only. Vault contents are
// intentionally excluded; future schema bumps must include migration logic.
export const exportSettings = async (vaultRoot: string): Promise<SettingsBundle> => {
  const settingsRaw = await readJson<unknown>(join(vaultRoot, '_BAC', '.config', 'settings.json'));
  const settings = settingsDocumentSchema.parse(settingsRaw);
  const workstreams = await readRecords<WorkstreamRecord>(
    join(vaultRoot, '_BAC', 'workstreams'),
    (value) => {
      const parsed = workstreamBundleRecordSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  );
  const templates = await readRecords<TemplateRecord>(
    join(vaultRoot, '_BAC', 'templates'),
    (value) => {
      const parsed = templateBundleRecordSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  );
  return settingsBundleSchema.parse({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    settings,
    workstreams,
    templates,
  });
};
