import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Persist the MCP WebSocket auth key alongside the bridge key in the
// vault's _BAC/.config directory. The key is used by:
//   - the sidetrack-mcp WS server (passed via --mcp-auth-key)
//   - the side-panel attach-prompt builder (embedded into ?token=…)
// Both reach the same on-disk file via the companion, so the user
// never has to coordinate keys between two processes by hand.

export const mcpAuthKeyPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'mcp-auth.key');

export const createMcpAuthKey = (): string => randomBytes(32).toString('base64url');

export interface EnsuredMcpAuthKey {
  readonly key: string;
  readonly path: string;
  readonly created: boolean;
}

export const ensureMcpAuthKey = async (vaultPath: string): Promise<EnsuredMcpAuthKey> => {
  const path = mcpAuthKeyPath(vaultPath);
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

  const key = createMcpAuthKey();
  await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
  await writeFile(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return { key, path, created: true };
};
