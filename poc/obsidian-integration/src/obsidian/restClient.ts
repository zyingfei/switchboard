import type { FrontmatterValue, ObsidianConnection, PluginProbe, VaultFileSummary } from './model';

export class ObsidianRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ObsidianRestError';
  }
}

type FetchLike = typeof fetch;

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/u, '');

const encodeVaultPath = (path: string): string =>
  path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');

export class ObsidianRestClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    connection: ObsidianConnection,
    fetchImpl: FetchLike = ((input, init) => fetch(input, init)) as FetchLike,
  ) {
    this.baseUrl = normalizeBaseUrl(connection.baseUrl);
    this.apiKey = connection.apiKey;
    this.fetchImpl = fetchImpl;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new ObsidianRestError(`Obsidian REST request failed: ${response.status}`, response.status);
    }
    return response;
  }

  async probe(): Promise<PluginProbe> {
    const response = await this.request('/');
    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: true,
      version: String(raw.version ?? raw.pluginVersion ?? 'unknown'),
      service: String(raw.service ?? raw.name ?? 'Obsidian Local REST API'),
    };
  }

  async listFiles(prefix = ''): Promise<VaultFileSummary[]> {
    const path = prefix ? `/vault/${encodeVaultPath(prefix)}` : '/vault/';
    const response = await this.request(path);
    const raw = (await response.json()) as { files?: VaultFileSummary[] | string[] };
    const files = raw.files ?? [];
    return files.map((file) =>
      typeof file === 'string'
        ? {
            path: file,
            type: file.endsWith('/') ? 'folder' : 'file',
          }
        : file,
    );
  }

  async readFile(path: string): Promise<string> {
    const response = await this.request(`/vault/${encodeVaultPath(path)}`);
    return await response.text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.request(`/vault/${encodeVaultPath(path)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
      },
      body: content,
    });
  }

  async deleteFile(path: string): Promise<void> {
    await this.request(`/vault/${encodeVaultPath(path)}`, {
      method: 'DELETE',
    });
  }

  async patchFrontmatter(path: string, key: string, value: FrontmatterValue): Promise<void> {
    await this.request(`/vault/${encodeVaultPath(path)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Operation: 'replace',
        'Target-Type': 'frontmatter',
        Target: key,
        'Create-Target-If-Missing': 'true',
      },
      body: JSON.stringify(value),
    });
  }

  async patchHeading(path: string, heading: string, markdown: string): Promise<void> {
    await this.request(`/vault/${encodeVaultPath(path)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        Operation: 'append',
        'Target-Type': 'heading',
        Target: heading,
        'Create-Target-If-Missing': 'true',
      },
      body: markdown,
    });
  }
}
