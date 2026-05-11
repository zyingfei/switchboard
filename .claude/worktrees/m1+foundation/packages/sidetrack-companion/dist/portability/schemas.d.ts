import { z } from 'zod';
export declare const workstreamBundleRecordSchema: z.ZodObject<{
    bac_id: z.ZodString;
}, z.core.$loose>;
export declare const templateBundleRecordSchema: z.ZodObject<{
    bac_id: z.ZodString;
}, z.core.$loose>;
export declare const settingsBundleSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    exportedAt: z.ZodISODateTime;
    settings: z.ZodObject<{
        autoSendOptIn: z.ZodObject<{
            chatgpt: z.ZodBoolean;
            claude: z.ZodBoolean;
            gemini: z.ZodBoolean;
        }, z.core.$strip>;
        defaultPacketKind: z.ZodEnum<{
            other: "other";
            research: "research";
            review: "review";
            coding: "coding";
            note: "note";
        }>;
        defaultDispatchTarget: z.ZodEnum<{
            chatgpt: "chatgpt";
            claude: "claude";
            gemini: "gemini";
            codex: "codex";
            claude_code: "claude_code";
            cursor: "cursor";
            other: "other";
        }>;
        screenShareSafeMode: z.ZodBoolean;
        revision: z.ZodString;
    }, z.core.$strip>;
    workstreams: z.ZodArray<z.ZodObject<{
        bac_id: z.ZodString;
    }, z.core.$loose>>;
    templates: z.ZodArray<z.ZodObject<{
        bac_id: z.ZodString;
    }, z.core.$loose>>;
}, z.core.$strip>;
export interface ConflictRecord {
    readonly kind: 'workstream' | 'template';
    readonly bac_id: string;
    readonly reason: 'already_exists';
}
export type WorkstreamRecord = z.infer<typeof workstreamBundleRecordSchema>;
export type TemplateRecord = z.infer<typeof templateBundleRecordSchema>;
export type SettingsBundle = z.infer<typeof settingsBundleSchema>;
//# sourceMappingURL=schemas.d.ts.map