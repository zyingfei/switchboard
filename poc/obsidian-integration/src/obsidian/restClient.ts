import type { FrontmatterValue, ObsidianConnection, PluginProbe, VaultFileSummary } from './model';

export class ObsidianRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ObsidianRestError';
  }
}

type FetchLike = typeof fetch;

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/u, '');
const markdownContentType = 'text/markdown';
const jsonContentType = 'application/json';
const normalizeVaultPrefix = (prefix: string): string => prefix.replace(/^\/+|\/+$/gu, '');

const compactErrorDetail = (body: string, contentType: string | null): string | undefined => {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }

  if (contentType?.includes(jsonContentType)) {
    try {
      const parsed = JSON.parse(trimmed) as { errorCode?: unknown; message?: unknown };
      const message = typeof parsed.message === 'string' ? parsed.message : trimmed;
      const code =
        typeof parsed.errorCode === 'number' || typeof parsed.errorCode === 'string'
          ? ` (${parsed.errorCode})`
          : '';
      return `${message}${code}`;
    } catch {
      return trimmed.slice(0, 400);
    }
  }

  return trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed;
};

const encodeVaultPath = (path: string): string =>
  path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');

const joinListedPath = (prefix: string, listedPath: string): string => {
  const normalizedListedPath = listedPath.replace(/^\/+|\/+$/gu, '');
  if (!prefix || normalizedListedPath === prefix || normalizedListedPath.startsWith(`${prefix}/`)) {
    return normalizedListedPath;
  }
  return `${prefix}/${normalizedListedPath}`;
};

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
      const detail = compactErrorDetail(
        await response.text().catch(() => ''),
        response.headers.get('Content-Type'),
      );
      throw new ObsidianRestError(
        `Obsidian REST request failed: ${response.status}${detail ? ` - ${detail}` : ''}`,
        response.status,
        detail,
      );
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
    const normalizedPrefix = normalizeVaultPrefix(prefix);
    const path = normalizedPrefix ? `/vault/${encodeVaultPath(normalizedPrefix)}/` : '/vault/';
    const response = await this.request(path);
    const raw = (await response.json()) as { files?: VaultFileSummary[] | string[] };
    const files = raw.files ?? [];
    return files.map((file) =>
      typeof file === 'string'
        ? {
            path: joinListedPath(normalizedPrefix, file),
            type: file.endsWith('/') ? 'folder' : 'file',
          }
        : {
            ...file,
            path: joinListedPath(normalizedPrefix, file.path),
          },
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
        'Content-Type': markdownContentType,
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
        'Content-Type': jsonContentType,
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
        'Content-Type': markdownContentType,
        Operation: 'append',
        'Target-Type': 'heading',
        Target: heading,
        'Create-Target-If-Missing': 'true',
      },
      body: markdown,
    });
  }
}
