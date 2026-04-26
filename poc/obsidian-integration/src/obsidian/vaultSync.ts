import { buildWhereWasIBase } from './base';
import { buildSwitchboardCanvas, serializeCanvas, validateCanvasDocument } from './canvas';
import {
  getFrontmatterString,
  getFrontmatterStringArray,
  parseFrontmatter,
} from './frontmatter';
import { buildProjectPath, buildInboxPath, markdownPath } from './paths';
import { buildThreadNote } from './threadNote';
import type {
  BacThreadRecord,
  EvidenceItem,
  FrontmatterValue,
  PluginProbe,
  ThinSliceResult,
  VaultFileSummary,
} from './model';

export interface VaultClient {
  probe(): Promise<PluginProbe>;
  listFiles(prefix?: string): Promise<VaultFileSummary[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  patchFrontmatter(path: string, key: string, value: FrontmatterValue): Promise<void>;
  patchHeading(path: string, heading: string, markdown: string): Promise<void>;
}

const status = (condition: boolean): EvidenceItem['status'] => (condition ? 'passed' : 'failed');

const evidence = (
  id: string,
  label: string,
  condition: boolean,
  detail: string,
): EvidenceItem => ({
  id,
  label,
  status: status(condition),
  detail,
});

export const readThreadRecord = (path: string, markdown: string): BacThreadRecord | null => {
  const fm = parseFrontmatter(markdown);
  if (fm.bac_type !== 'thread' || typeof fm.bac_id !== 'string') {
    return null;
  }
  return {
    bacId: fm.bac_id,
    path,
    title: getFrontmatterString(markdown, 'title') ?? path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
    provider: getFrontmatterString(markdown, 'provider') ?? 'unknown',
    sourceUrl: getFrontmatterString(markdown, 'source_url') ?? '',
    status: getFrontmatterString(markdown, 'status') ?? 'unknown',
    project: getFrontmatterString(markdown, 'project') ?? '',
    topic: getFrontmatterString(markdown, 'topic') ?? '',
    tags: getFrontmatterStringArray(markdown, 'tags'),
    related: getFrontmatterStringArray(markdown, 'related'),
    content: markdown,
  };
};

export const scanThreadByBacId = async (
  client: VaultClient,
  bacId: string,
): Promise<BacThreadRecord | null> => {
  const files = await client.listFiles();
  for (const file of files.filter((entry) => entry.type === 'file' && markdownPath(entry.path))) {
    const markdown = await client.readFile(file.path);
    if (getFrontmatterString(markdown, 'bac_id') === bacId) {
      return readThreadRecord(file.path, markdown);
    }
  }
  return null;
};

export const queryWhereWasI = async (
  client: VaultClient,
  project: string,
): Promise<BacThreadRecord[]> => {
  const files = await client.listFiles();
  const records: BacThreadRecord[] = [];
  for (const file of files.filter((entry) => entry.type === 'file' && markdownPath(entry.path))) {
    const record = readThreadRecord(file.path, await client.readFile(file.path));
    if (record && record.project === project && record.status !== 'archived') {
      records.push(record);
    }
  }
  return records.sort((left, right) => left.title.localeCompare(right.title));
};

export const runThinSliceProof = async (
  client: VaultClient,
  generatedAt: string,
): Promise<ThinSliceResult> => {
  const start = Date.now();
  const plugin = await client.probe();
  const evidenceItems: EvidenceItem[] = [
    evidence('plugin-detected', 'A1/A2 auth and plugin detection', plugin.ok, `${plugin.service} ${plugin.version}`),
  ];
  const bacId = 'thread_obsidian_poc_001';
  const title = 'Claude - Browser-owned MCP';
  const originalPath = buildInboxPath(generatedAt, title);
  const movedPath = buildProjectPath('SwitchBoard', 'MCP discussion');
  const dashboardPath = '_BAC/dashboards/where-was-i.md';
  const canvasPath = '_BAC/canvases/switchboard-map.canvas';
  const basePath = '_BAC/dashboards/where-was-i.base';
  const sourceUrl = 'https://claude.ai/chat/mock-obsidian-poc';

  const initialNote = buildThreadNote({
    bacId,
    title,
    provider: 'claude',
    sourceUrl,
    status: 'tracked',
    project: 'Inbox',
    topic: 'High Level Design',
    tags: ['bac/thread', 'provider/claude'],
    related: ['[[BRAINSTORM]]'],
    createdAt: generatedAt,
  });

  await client.writeFile(originalPath, initialNote);
  const written = await client.readFile(originalPath);
  evidenceItems.push(
    evidence(
      'crud',
      'A4 basic CRUD write/read',
      written.includes(bacId) && written.includes('Untouched Section'),
      originalPath,
    ),
  );

  await client.patchFrontmatter(originalPath, 'project', 'SwitchBoard');
  await client.patchFrontmatter(originalPath, 'topic', 'High Level Design');
  await client.patchFrontmatter(originalPath, 'tags', ['bac/thread', 'provider/claude', 'project/switchboard']);
  const frontmatterPatched = await client.readFile(originalPath);
  evidenceItems.push(
    evidence(
      'frontmatter-patch',
      'A5 PATCH frontmatter target',
      getFrontmatterString(frontmatterPatched, 'project') === 'SwitchBoard' &&
        getFrontmatterStringArray(frontmatterPatched, 'tags').includes('project/switchboard'),
      'project and tags updated without replacing the body',
    ),
  );

  await client.patchHeading(originalPath, 'Notes', '- PATCH-heading appended this line.');
  const headingPatched = await client.readFile(originalPath);
  evidenceItems.push(
    evidence(
      'heading-patch',
      'A6 PATCH heading target',
      headingPatched.includes('- PATCH-heading appended this line.') &&
        headingPatched.includes('This section must survive heading-target PATCHes unchanged.'),
      'Notes section appended while Untouched Section remained',
    ),
  );

  await client.writeFile(movedPath, headingPatched);
  await client.deleteFile(originalPath);
  const foundAfterMove = await scanThreadByBacId(client, bacId);
  evidenceItems.push(
    evidence(
      'bac-id-scan',
      'B4 bac_id stable identity after rename/move',
      foundAfterMove?.path === movedPath,
      foundAfterMove ? `found at ${foundAfterMove.path}` : 'not found',
    ),
  );

  await client.patchFrontmatter(movedPath, 'topic', 'Security');
  const foundAfterRoundTrip = await scanThreadByBacId(client, bacId);
  evidenceItems.push(
    evidence(
      'round-trip-frontmatter',
      'B5 frontmatter round-trip scan',
      foundAfterRoundTrip?.topic === 'Security',
      `topic=${foundAfterRoundTrip?.topic ?? 'missing'}`,
    ),
  );

  const dashboardMatches = await queryWhereWasI(client, 'SwitchBoard');
  const dashboardMarkdown = [
    '# Where Was I',
    '',
    '| Title | Provider | Topic | Status | Path |',
    '|---|---|---|---|---|',
    ...dashboardMatches.map(
      (record) => `| ${record.title} | ${record.provider} | ${record.topic} | ${record.status} | ${record.path} |`,
    ),
    '',
  ].join('\n');
  await client.writeFile(dashboardPath, dashboardMarkdown);

  const canvas = buildSwitchboardCanvas('SwitchBoard', 'Security', dashboardMatches);
  const canvasErrors = validateCanvasDocument(canvas);
  await client.writeFile(canvasPath, serializeCanvas(canvas));
  evidenceItems.push(
    evidence(
      'canvas-json',
      'C1/C2/C4 minimal canvas file',
      canvasErrors.length === 0,
      canvasErrors.length === 0 ? `${canvas.nodes.length} nodes with 16-char hex ids` : canvasErrors.join('; '),
    ),
  );

  const baseContent = buildWhereWasIBase({ project: 'SwitchBoard' });
  await client.writeFile(basePath, baseContent);
  evidenceItems.push(
    evidence(
      'base-yaml',
      'D1/D3 minimal Bases dashboard',
      baseContent.includes('bac_type == "thread"') && baseContent.includes('project == "SwitchBoard"'),
      basePath,
    ),
  );

  evidenceItems.push(
    evidence(
      'inbox-structure',
      'F1/F2 _BAC reserved folder and inbox-first path',
      originalPath.startsWith('_BAC/inbox/') && dashboardPath.startsWith('_BAC/dashboards/'),
      `${originalPath} -> ${movedPath}`,
    ),
  );

  return {
    generatedAt,
    plugin,
    bacId,
    originalPath,
    movedPath,
    dashboardPath,
    canvasPath,
    basePath,
    evidence: evidenceItems,
    foundRecord: foundAfterRoundTrip,
    dashboardMatches,
    latencyMs: Date.now() - start,
  };
};
