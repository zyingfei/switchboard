import { z } from 'zod';

import { settingsDocumentSchema } from '../http/schemas.js';

export const workstreamBundleRecordSchema = z.looseObject({
  bac_id: z.string().min(1),
});

export const templateBundleRecordSchema = z.looseObject({
  bac_id: z.string().min(1),
});

export const settingsBundleSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime(),
  settings: settingsDocumentSchema,
  workstreams: z.array(workstreamBundleRecordSchema),
  templates: z.array(templateBundleRecordSchema),
});

export interface ConflictRecord {
  readonly kind: 'workstream' | 'template';
  readonly bac_id: string;
  readonly reason: 'already_exists';
}

export type WorkstreamRecord = z.infer<typeof workstreamBundleRecordSchema>;
export type TemplateRecord = z.infer<typeof templateBundleRecordSchema>;
export type SettingsBundle = z.infer<typeof settingsBundleSchema>;
