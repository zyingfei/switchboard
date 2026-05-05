import type { McpServerConfig } from './types';

export interface McpProbeResult {
  readonly online: boolean;
  readonly checkedAt: string;
  readonly error?: string;
}

const isOnlineStatus = (status: number): boolean => status >= 200 && status < 400;

export const probeServer = async (server: McpServerConfig): Promise<McpProbeResult> => {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(server.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2_000),
    });
    return { online: isOnlineStatus(response.status), checkedAt };
  } catch (error) {
    return {
      online: false,
      checkedAt,
      error: error instanceof Error ? error.message : 'probe failed',
    };
  }
};
