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

export interface BacThreadRecord {
  bacId: string;
  path: string;
  title: string;
  provider: string;
  sourceUrl: string;
  status: string;
  project: string;
  topic: string;
  tags: string[];
  related: string[];
  content: string;
}

export interface EvidenceItem {
  id: string;
  label: string;
  status: 'passed' | 'warning' | 'failed';
  detail: string;
}

export interface ThinSliceResult {
  generatedAt: string;
  plugin: PluginProbe;
  bacId: string;
  originalPath: string;
  movedPath: string;
  dashboardPath: string;
  canvasPath: string;
  basePath: string;
  evidence: EvidenceItem[];
  foundRecord: BacThreadRecord | null;
  dashboardMatches: BacThreadRecord[];
  latencyMs: number;
}
