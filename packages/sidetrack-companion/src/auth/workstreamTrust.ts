import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const workstreamWriteTools = [
  'sidetrack.threads.move',
  'sidetrack.queue.create',
  'sidetrack.workstreams.bump',
  'sidetrack.threads.archive',
  'sidetrack.threads.unarchive',
  // F32 — workstream create. When an MCP caller creates a CHILD
  // workstream, the create is trust-gated on the PARENT (you must be
  // trusted to add children under it); a top-level create has no scope
  // to check and passes.
  'sidetrack.workstreams.create',
] as const;

export type WorkstreamWriteTool = (typeof workstreamWriteTools)[number];

export interface Trust {
  readonly workstreamId: string;
  readonly allowedTools: ReadonlySet<WorkstreamWriteTool>;
}

const isWorkstreamWriteTool = (value: unknown): value is WorkstreamWriteTool =>
  typeof value === 'string' && workstreamWriteTools.some((candidate) => candidate === value);

const trustPath = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'trust.json');

export const readTrust = async (vaultRoot: string): Promise<readonly Trust[]> => {
  try {
    const parsed = JSON.parse(await readFile(trustPath(vaultRoot), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [];
    }
    const list = (parsed as { readonly workstreams?: unknown }).workstreams;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.flatMap((item): readonly Trust[] => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return [];
      }
      const record = item as { readonly workstreamId?: unknown; readonly allowedTools?: unknown };
      if (typeof record.workstreamId !== 'string' || !Array.isArray(record.allowedTools)) {
        return [];
      }
      return [
        {
          workstreamId: record.workstreamId,
          allowedTools: new Set(record.allowedTools.filter(isWorkstreamWriteTool)),
        },
      ];
    });
  } catch {
    return [];
  }
};

export const writeTrust = async (vaultRoot: string, list: readonly Trust[]): Promise<void> => {
  const serializable = {
    workstreams: list.map((record) => ({
      workstreamId: record.workstreamId,
      allowedTools: [...record.allowedTools],
    })),
  };
  await mkdir(join(vaultRoot, '_BAC'), { recursive: true });
  await writeFile(trustPath(vaultRoot), `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
};

// Deny-by-default for workstreams that have never had an explicit trust
// record persisted (PRD §6.1.14, re-recorded 2026-07-11: MCP write
// trust is opt-in). An MCP-key caller must be explicitly granted a tool
// on a workstream before it can drive that write; the extension surface
// (user's own bridge key) is exempt from this gate. Once a trust record
// exists, its allowed-set is honored as-is — a granted tool passes, a
// tool absent from the set is denied.
export const isAllowed = (
  workstreamId: string,
  tool: WorkstreamWriteTool,
  list: readonly Trust[],
): boolean => {
  const record = list.find((entry) => entry.workstreamId === workstreamId);
  if (record === undefined) return false;
  return record.allowedTools.has(tool);
};

// What the trust GET endpoint should return when no explicit record
// exists for a workstream. Mirrors the isAllowed deny-by-default so the
// side panel renders all toggles OFF for a fresh workstream — the user
// grants tools explicitly (a PUT records the allow-list).
export const defaultAllowedTools = (): readonly WorkstreamWriteTool[] => [];
