import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  readonly at: string;
  readonly tool: string;
  readonly args: unknown;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly summary?: Record<string, unknown>;
  readonly error?: string;
}

export const appendAuditEntry = async (auditLogPath: string, entry: AuditEntry): Promise<void> => {
  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  await fs.appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
};
