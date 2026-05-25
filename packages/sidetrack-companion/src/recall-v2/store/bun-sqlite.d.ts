// Minimal type stub for `bun:sqlite` so tsc with `types: ["node", "vitest"]`
// can resolve the module without pulling in the full bun-types package.
// Mirrors the subset of the API used by sqlite.ts; expand if usage grows.

declare module 'bun:sqlite' {
  export interface Statement<TRow = unknown> {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    get(...params: unknown[]): TRow | undefined;
    all(...params: unknown[]): TRow[];
    finalize(): void;
  }

  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean });
    exec(sql: string): void;
    prepare<TRow = unknown>(sql: string): Statement<TRow>;
    run(sql: string, ...params: unknown[]): void;
    query<TRow = unknown>(sql: string): Statement<TRow>;
    close(): void;
  }
}
