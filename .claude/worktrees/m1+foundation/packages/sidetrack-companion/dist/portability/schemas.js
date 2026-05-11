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
//# sourceMappingURL=schemas.js.map