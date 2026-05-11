export interface RedactionResult {
    readonly output: string;
    readonly matched: number;
    readonly categories: readonly string[];
}
export declare const redact: (input: string) => RedactionResult;
//# sourceMappingURL=redaction.d.ts.map