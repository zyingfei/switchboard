import { expect, test } from '@playwright/test';
import { launchExtensionRuntime, openSidepanelPage } from './helpers/runtime';
import { startFixtureObsidianServer } from './helpers/fixtureObsidian';

test('proves Obsidian REST thin slice with frontmatter, identity, canvas, and base artifacts', async () => {
  const fixture = await startFixtureObsidianServer();
  const runtime = await launchExtensionRuntime();

  try {
    const sidepanel = await openSidepanelPage(runtime.context, runtime.extensionId);
    await expect(sidepanel.getByRole('heading', { name: 'BAC Obsidian POC' })).toBeVisible();

    await sidepanel.getByLabel('REST endpoint').fill(fixture.url);
    await sidepanel.getByLabel('API key').fill(fixture.apiKey);
    await sidepanel.getByRole('button', { name: 'Run thin slice' }).click();

    await expect(sidepanel.getByTestId('evidence-plugin-detected')).toContainText('passed', {
      timeout: 20_000,
    });
    await expect(sidepanel.getByTestId('evidence-crud')).toContainText('passed');
    await expect(sidepanel.getByTestId('evidence-frontmatter-patch')).toContainText('passed');
    await expect(sidepanel.getByTestId('evidence-heading-patch')).toContainText('passed');
    await expect(sidepanel.getByTestId('evidence-bac-id-scan')).toContainText('passed');
    await expect(sidepanel.getByTestId('evidence-round-trip-frontmatter')).toContainText('passed');
    await expect(sidepanel.getByTestId('evidence-canvas-json')).toContainText('passed');
    await expect(sidepanel.getByTestId('evidence-base-yaml')).toContainText('passed');
    await expect(sidepanel.getByTestId('found-topic')).toHaveText('Security');

    const movedPath = await sidepanel.getByTestId('moved-path').textContent();
    const canvasPath = await sidepanel.getByTestId('canvas-path').textContent();
    const basePath = await sidepanel.getByTestId('base-path').textContent();

    expect(movedPath).toBe('Projects/SwitchBoard/MCP discussion.md');
    expect(canvasPath).toBe('_BAC/canvases/switchboard-map.canvas');
    expect(basePath).toBe('_BAC/dashboards/where-was-i.base');

    const movedFile = fixture.read(movedPath ?? '');
    expect(movedFile).toContain('bac_id: thread_obsidian_poc_001');
    expect(movedFile).toContain('project: SwitchBoard');
    expect(movedFile).toContain('topic: Security');
    expect(movedFile).toContain('PATCH-heading appended this line.');
    expect(movedFile).toContain('This section must survive heading-target PATCHes unchanged.');

    const canvas = JSON.parse(fixture.read(canvasPath ?? '') ?? '{}') as {
      nodes: Array<{ id: string; type: string; file?: string; text?: string }>;
      edges: unknown[];
    };
    expect(canvas.nodes.every((node) => /^[0-9a-f]{16}$/u.test(node.id))).toBe(true);
    expect(canvas.nodes.some((node) => node.type === 'file' && node.file === movedPath)).toBe(true);
    expect(canvas.nodes.some((node) => node.type === 'group')).toBe(true);
    expect(canvas.edges).toEqual([]);

    const base = fixture.read(basePath ?? '');
    expect(base).toContain('bac_type == "thread"');
    expect(base).toContain('project == "SwitchBoard"');

    await sidepanel.reload({ waitUntil: 'domcontentloaded' });
    await expect(sidepanel.getByTestId('found-topic')).toHaveText('Security');
    await expect(sidepanel.getByTestId('file-list')).toContainText('_BAC/dashboards/where-was-i.base');
  } finally {
    await runtime.close();
    await fixture.close();
  }
});
