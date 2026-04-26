import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchExtensionRuntime } from './helpers/runtime';

const fixtureRoot = path.resolve(process.cwd(), 'fixtures/provider-pages');

const fixtureFile = (name: string): string => path.join(fixtureRoot, name);

const startFixtureServer = async (): Promise<{ server: Server; origin: string }> =>
  await new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname === '/' ? '/chatgpt.html' : url.pathname;
        if (pathname === '/downloads/upgraded-bundle.zip') {
          response.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="upgraded-bundle.zip"',
          });
          response.end('fake zip payload');
          return;
        }
        if (pathname === '/downloads/research-sources.csv') {
          response.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="research-sources.csv"',
          });
          response.end('title,url\nArchitecture,https://docs.vanarchain.com/getting-started/vanar-architecture\n');
          return;
        }
        const filePath = fixtureFile(pathname.replace(/^\//, ''));
        const html = await readFile(filePath, 'utf8');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
      } catch {
        response.writeHead(404);
        response.end('not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve fixture server address.'));
        return;
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
    server.on('error', reject);
  });

const closeFixtureServer = async (server: Server): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const refreshSidepanel = async (sidepanelPage: Page) => {
  await sidepanelPage.getByRole('button', { name: 'Refresh' }).click();
};

test('captures provider fixture tabs and persists results in local extension storage', async () => {
  const fixtureServer = await startFixtureServer();
  const runtime = await launchExtensionRuntime();

  try {
    const chatgptPage = await runtime.context.newPage();
    await chatgptPage.goto(`${fixtureServer.origin}/chatgpt.html?provider=chatgpt`, {
      waitUntil: 'domcontentloaded',
    });
    const sidepanelPage = await runtime.context.newPage();
    await sidepanelPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(sidepanelPage.getByText('No captures yet.')).toBeVisible();
    await expect(sidepanelPage.getByTestId('active-title')).toContainText('ChatGPT Fixture Thread');
    await sidepanelPage.getByTestId('capture-active-tab').click();
    await expect(sidepanelPage.getByTestId('capture-card-chatgpt')).toContainText('2 turns');

    const claudePage = await runtime.context.newPage();
    await claudePage.goto(`${fixtureServer.origin}/claude.html?provider=claude`, {
      waitUntil: 'domcontentloaded',
    });
    await claudePage.bringToFront();
    await sidepanelPage.bringToFront();
    await refreshSidepanel(sidepanelPage);
    await expect(sidepanelPage.getByTestId('active-title')).toContainText('Claude Fixture Thread');
    await sidepanelPage.getByTestId('capture-active-tab').click();
    await expect(sidepanelPage.getByTestId('capture-card-claude')).toContainText('2 turns');

    const geminiPage = await runtime.context.newPage();
    await geminiPage.goto(`${fixtureServer.origin}/gemini.html?provider=gemini`, {
      waitUntil: 'domcontentloaded',
    });
    await geminiPage.bringToFront();
    await sidepanelPage.bringToFront();
    await refreshSidepanel(sidepanelPage);
    await expect(sidepanelPage.getByTestId('active-title')).toContainText('Gemini Fixture Thread');
    await sidepanelPage.getByTestId('capture-active-tab').click();
    await expect(sidepanelPage.getByTestId('capture-card-gemini')).toContainText('2 turns');

    await sidepanelPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(sidepanelPage.getByTestId('capture-card-gemini')).toBeVisible();
    await expect(sidepanelPage.getByTestId('capture-card-claude')).toBeVisible();
    await expect(sidepanelPage.getByTestId('capture-card-chatgpt')).toBeVisible();
    await sidepanelPage.getByTestId('capture-card-chatgpt').click();
    await expect(sidepanelPage.getByTestId('capture-preview')).toContainText('```bash');
    await expect(sidepanelPage.getByTestId('capture-preview')).toContainText('| Risk | Mitigation |');

    const downloadPromise = sidepanelPage.waitForEvent('download');
    await sidepanelPage.getByTestId('save-formatted-capture').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('chatgpt-chatgpt-fixture-thread');
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const markdown = await readFile(downloadPath as string, 'utf8');
    expect(markdown).toContain('# ChatGPT Fixture Thread');
    expect(markdown).toContain('```bash');
    expect(markdown).toContain('| Risk | Mitigation |');
  } finally {
    await runtime.close();
    await closeFixtureServer(fixtureServer.server);
  }
});

test('captures embedded research iframe artifacts and exposes artifact controls', async () => {
  const fixtureServer = await startFixtureServer();
  const runtime = await launchExtensionRuntime();

  try {
    const researchPage = await runtime.context.newPage();
    await researchPage.goto(`${fixtureServer.origin}/chatgpt-research.html?provider=chatgpt`, {
      waitUntil: 'domcontentloaded',
    });

    const sidepanelPage = await runtime.context.newPage();
    await sidepanelPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(sidepanelPage.getByTestId('active-title')).toContainText('ChatGPT Research Fixture');
    await sidepanelPage.getByTestId('capture-active-tab').click();

    await expect(sidepanelPage.getByTestId('capture-card-chatgpt')).toContainText('+ 1 artifact');
    await expect(sidepanelPage.getByTestId('capture-artifacts')).toContainText('Analytical Due Diligence on and');
    await expect(sidepanelPage.getByTestId('capture-artifacts')).toContainText('Research completed in 16m');
    await expect(sidepanelPage.getByRole('button', { name: 'Download the 4+ upgraded bundle' })).toBeVisible();
    await expect(sidepanelPage.getByRole('button', { name: 'Open supporting spreadsheet' })).toBeVisible();

    await sidepanelPage.getByRole('button', { name: 'Save artifact' }).click();
    await expect(sidepanelPage.getByTestId('capture-status')).toContainText('Saved artifact: Analytical Due Diligence on and');
  } finally {
    await runtime.close();
    await closeFixtureServer(fixtureServer.server);
  }
});
