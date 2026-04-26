import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { RuntimeDevice } from '../../recall-vector/src/recall/model';

const embedderSchema = z
  .object({
    kind: z.enum(['hashing', 'transformers']).optional(),
    device: z.enum(['wasm', 'webgpu', 'cpu']).optional(),
  })
  .optional();

const rawConfigSchema = z.object({
  vaultPath: z.string().min(1),
  providerCapturesPath: z.string().min(1),
  project: z.string().min(1).optional(),
  currentNotePath: z.string().min(1).optional(),
  auditLogPath: z.string().min(1).optional(),
  screenShareSafe: z.boolean().optional(),
  embedder: embedderSchema,
});

const usageText = `BAC MCP server POC

Usage:
  npm start -- --config ./fixtures/demo-config.json
  node ./dist/cli.js --config /absolute/path/to/config.json

Environment overrides:
  BAC_VAULT_PATH
  BAC_PROVIDER_CAPTURES_PATH
  BAC_PROJECT
  BAC_CURRENT_NOTE_PATH
  BAC_AUDIT_LOG_PATH
  BAC_SCREEN_SHARE_SAFE
  BAC_EMBEDDER_KIND
  BAC_EMBEDDER_DEVICE
`;

export interface ServerConfig {
  readonly configPath: string;
  readonly vaultPath: string;
  readonly providerCapturesPath: string;
  readonly project: string;
  readonly currentNotePath?: string;
  readonly auditLogPath: string;
  readonly screenShareSafe: boolean;
  readonly embedder: {
    readonly kind: 'hashing' | 'transformers';
    readonly device: RuntimeDevice;
  };
}

const defaultConfigPath = (): string => fileURLToPath(new URL('../fixtures/demo-config.json', import.meta.url));

const resolvePath = (baseDir: string, value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(baseDir, value);

const readBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (value === '1' || value.toLowerCase() === 'true') {
    return true;
  }
  if (value === '0' || value.toLowerCase() === 'false') {
    return false;
  }
  return fallback;
};

const readDevice = (value: string | undefined, fallback: RuntimeDevice): RuntimeDevice =>
  value === 'wasm' || value === 'webgpu' || value === 'cpu' ? value : fallback;

const readEmbedderKind = (
  value: string | undefined,
  fallback: ServerConfig['embedder']['kind'],
): ServerConfig['embedder']['kind'] => (value === 'hashing' || value === 'transformers' ? value : fallback);

export const parseCliArgs = (
  argv: string[],
): {
  configPath?: string;
  help: boolean;
} => {
  let configPath: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--help' || current === '-h') {
      help = true;
      continue;
    }
    if (current === '--config') {
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  return {
    configPath,
    help,
  };
};

export const printUsage = (): void => {
  process.stderr.write(`${usageText}\n`);
};

export const loadConfig = async (configPathArg?: string): Promise<ServerConfig> => {
  const configPath = resolvePath(process.cwd(), configPathArg ?? defaultConfigPath());
  const configDir = path.dirname(configPath);
  const rawConfig = JSON.parse(await fs.readFile(configPath, 'utf8')) as unknown;
  const parsed = rawConfigSchema.parse(rawConfig);

  const project = process.env.BAC_PROJECT || parsed.project || 'SwitchBoard';
  const currentNotePath = process.env.BAC_CURRENT_NOTE_PATH || parsed.currentNotePath;
  const screenShareSafe = readBoolean(process.env.BAC_SCREEN_SHARE_SAFE, parsed.screenShareSafe ?? false);
  const embedderKind = readEmbedderKind(process.env.BAC_EMBEDDER_KIND, parsed.embedder?.kind ?? 'hashing');
  const embedderDevice = readDevice(process.env.BAC_EMBEDDER_DEVICE, parsed.embedder?.device ?? 'wasm');

  return {
    configPath,
    vaultPath: resolvePath(
      configDir,
      process.env.BAC_VAULT_PATH || parsed.vaultPath,
    ),
    providerCapturesPath: resolvePath(
      configDir,
      process.env.BAC_PROVIDER_CAPTURES_PATH || parsed.providerCapturesPath,
    ),
    project,
    currentNotePath,
    auditLogPath: resolvePath(
      configDir,
      process.env.BAC_AUDIT_LOG_PATH || parsed.auditLogPath || '../.data/audit-log.jsonl',
    ),
    screenShareSafe,
    embedder: {
      kind: embedderKind,
      device: embedderDevice,
    },
  };
};
