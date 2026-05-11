export interface Problem {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly code: string;
    readonly correlationId: string;
    readonly detail?: string;
    readonly instance?: string;
    readonly errors?: readonly {
        readonly path: string;
        readonly message: string;
    }[];
}
export interface ValidationIssue {
    readonly path: readonly (string | number | symbol)[];
    readonly message: string;
}
export declare const createProblem: (input: {
    readonly status: number;
    readonly code: string;
    readonly title: string;
    readonly correlationId: string;
    readonly detail?: string;
    readonly instance?: string;
    readonly issues?: readonly ValidationIssue[];
}) => Problem;
//# sourceMappingURL=problem.d.ts.map