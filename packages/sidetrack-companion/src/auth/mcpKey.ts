import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// MCP-scoped companion auth key (mcp.key). Written alongside bridge.key in
// _BAC/.config/ so the companion can classify callers by which key they
// present:
//   - bridge.key  → extension surface (exempt from workstream trust)
//   - mcp.key     → MCP surface (subject to workstream trust enforcement)
//
// The companion spawner passes mcp.key to the MCP child as its --bridge-key
// argument; the child presents it in x-bac-bridge-key and never sees the
// extension's bridge.key. The companion server wires the value into
// CompanionHttpConfig.mcpBridgeKey so the auth gate can distinguish the two.

export const mcpKeyPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'mcp.key');

export const createMcpKey = (): string => randomBytes(32).toString('base64url');

export interface EnsuredMcpKey {
  readonly key: string;
  readonly path: string;
  // True when this call wrote the file (first boot); false when an
  // existing key was reused. Matches the shape of EnsuredBridgeKey.
  readonly created: boolean;
}

export const ensureMcpKey = async (vaultPath: string): Promise<EnsuredMcpKey> => {
  const path = mcpKeyPath(vaultPath);
  try {
    const existing = await readFile(path, 'utf8');
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      return { key: trimmed, path, created: false };
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const key = createMcpKey();
  await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
  await writeFile(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return { key, path, created: true };
};
