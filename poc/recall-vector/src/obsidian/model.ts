export type FrontmatterValue = string | number | boolean | string[];

export interface PluginProbe {
  ok: boolean;
  version: string;
  service: string;
}

export interface ObsidianConnection {
  baseUrl: string;
  apiKey: string;
}

export interface VaultFileSummary {
  path: string;
  type: 'file' | 'folder';
  size?: number;
}

export interface VaultClient {
  probe(): Promise<PluginProbe>;
  listFiles(prefix?: string): Promise<VaultFileSummary[]>;
  readFile(path: string): Promise<string>;
}
