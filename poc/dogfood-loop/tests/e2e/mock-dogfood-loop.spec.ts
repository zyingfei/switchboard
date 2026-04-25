import { expect, test } from '@playwright/test';
import { launchExtensionRuntime, openSidepanelPage, waitForPageUrl } from './helpers/runtime';

test('proves note to mock chats to converge to accepted patch', async () => {
  const runtime = await launchExtensionRuntime();

  try {
    const sidepanel = await openSidepanelPage(runtime.context, runtime.extensionId);
    await expect(sidepanel.getByRole('heading', { name: 'Browser AI Companion' })).toBeVisible();

    await sidepanel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'POC_RESET' });
    });

    const sourceNote = '# Brainstorm\nPlease review this product idea.\n';
    await sidepanel.getByLabel('Markdown note').fill(sourceNote);
    await sidepanel.getByRole('button', { name: 'Fork to both chats' }).click();

    const chatA = await waitForPageUrl(
      runtime.context,
      (url) => url.includes('mock-chat.html') && url.includes('provider=mock-chat-a'),
    );
    const chatB = await waitForPageUrl(
      runtime.context,
      (url) => url.includes('mock-chat.html') && url.includes('provider=mock-chat-b'),
    );

    await expect(chatA.locator('[data-mock-chat-input]')).toHaveValue(/# Brainstorm/);
    await expect(chatB.locator('[data-mock-chat-input]')).toHaveValue(/# Brainstorm/);
    await expect(chatA.getByTestId('assistant-status')).toHaveText('done', { timeout: 10_000 });
    await expect(chatB.getByTestId('assistant-status')).toHaveText('done', { timeout: 10_000 });

    await expect(sidepanel.getByTestId('run-mock-chat-a')).toContainText('Done', { timeout: 10_000 });
    await expect(sidepanel.getByTestId('run-mock-chat-b')).toContainText('Done', { timeout: 10_000 });

    await sidepanel.getByRole('button', { name: 'Append both' }).click();
    await expect(sidepanel.getByTestId('patch-proposed')).toHaveValue(/Mock Chat A response/);
    await expect(sidepanel.getByTestId('patch-proposed')).toHaveValue(/Mock Chat B response/);

    await sidepanel.getByRole('button', { name: 'Accept patch' }).click();
    await expect(sidepanel.getByLabel('Markdown note')).toHaveValue(/## Converged Responses/);

    await sidepanel.reload({ waitUntil: 'domcontentloaded' });
    await expect(sidepanel.getByLabel('Markdown note')).toHaveValue(/Mock Chat A response/);
    await expect(sidepanel.getByLabel('Markdown note')).toHaveValue(/Mock Chat B response/);
  } finally {
    await runtime.close();
  }
});

test('forks a note to search engines and converges search artifacts', async () => {
  const runtime = await launchExtensionRuntime();

  try {
    const sidepanel = await openSidepanelPage(runtime.context, runtime.extensionId);
    await expect(sidepanel.getByRole('heading', { name: 'Browser AI Companion' })).toBeVisible();

    await sidepanel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'POC_RESET' });
    });

    await sidepanel
      .getByLabel('Markdown note')
      .fill('# Search Spike\nFind prior art for local-first AI workstream switchboards.\n');
    await sidepanel.getByRole('button', { name: 'Fork to search engines' }).click();

    await waitForPageUrl(
      runtime.context,
      (url) => url.includes('google.com/search') && url.includes('Search+Spike'),
    );
    await waitForPageUrl(
      runtime.context,
      (url) => url.includes('duckduckgo.com') && url.includes('Search+Spike'),
    );

    await expect(sidepanel.getByTestId('run-google-search')).toContainText('Done', {
      timeout: 20_000,
    });
    await expect(sidepanel.getByTestId('run-duckduckgo-search')).toContainText('Done', {
      timeout: 20_000,
    });
    await expect(sidepanel.getByTestId('response-google-search')).toContainText(
      'Google Search branch artifact',
    );
    await expect(sidepanel.getByTestId('response-duckduckgo-search')).toContainText(
      'DuckDuckGo Search branch artifact',
    );

    await sidepanel.getByRole('button', { name: 'Append both' }).click();
    await expect(sidepanel.getByTestId('patch-proposed')).toHaveValue(/Google Search artifact/);
    await expect(sidepanel.getByTestId('patch-proposed')).toHaveValue(/DuckDuckGo Search artifact/);
  } finally {
    await runtime.close();
  }
});

test('proves registry, vault projection, context pack, recall, and MCP smoke POCs', async () => {
  const runtime = await launchExtensionRuntime();

  try {
    const sidepanel = await openSidepanelPage(runtime.context, runtime.extensionId);
    await expect(sidepanel.getByRole('heading', { name: 'Browser AI Companion' })).toBeVisible();

    await sidepanel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'POC_RESET' });
    });

    await sidepanel
      .getByLabel('Markdown note')
      .fill('# Memory Ledger\nBuild a local-first AI workstream switchboard memory ledger.\n');
    await sidepanel.getByRole('button', { name: 'Save' }).click();

    const sourcePage = await runtime.context.newPage();
    await sourcePage.goto('data:text/html,<title>Adopted Source Page</title><h1>Research source</h1>');
    await sidepanel.bringToFront();
    await sidepanel.getByRole('button', { name: 'Add active tab to discussion' }).click();
    await expect(sidepanel.getByText('Adopted Source Page', { exact: true })).toBeVisible();

    await sidepanel.getByRole('button', { name: 'Open fixture threads' }).click();
    await expect(sidepanel.getByTestId('thread-chatgpt')).toContainText('Pricing experiment thread', {
      timeout: 10_000,
    });
    await expect(sidepanel.getByTestId('thread-claude')).toContainText('Auth refactor research');
    await expect(sidepanel.getByTestId('thread-gemini')).toContainText('Competitor scan');

    await sidepanel.getByRole('button', { name: 'Build vault projection' }).click();
    await expect(sidepanel.getByTestId('vault-projection')).toContainText('_BAC/events/');
    await expect(sidepanel.getByTestId('vault-projection')).toContainText('_BAC/where-was-i.base');

    await sidepanel.getByRole('button', { name: 'Build Context Pack' }).click();
    await expect(sidepanel.getByTestId('context-pack')).toContainText('BAC Context Pack');
    await expect(sidepanel.getByTestId('context-pack')).toContainText('Open Threads');

    await sidepanel.getByRole('button', { name: 'MCP smoke' }).click();
    await expect(sidepanel.getByTestId('mcp-smoke')).toContainText('Pricing experiment thread');

    await sidepanel.getByLabel('Recall probe').fill('local-first workstream switchboard memory');
    await sidepanel.getByRole('button', { name: 'Check déjà-vu' }).click();
    await expect(sidepanel.getByTestId('deja-vu-hits')).toContainText('Local markdown note');
  } finally {
    await runtime.close();
  }
});
