import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-05-05T12:00:00.000Z';
const companionPort = 17_373;
const bridgeKey = 'keyword_annotation_bridge_key_012345678901234567890123';
const threadUrl = 'https://chatgpt.com/c/hn-keyword-annotations';

const assistantText = [
  'HN article pick for 2026-05-05: a prototype browser-runtime architecture note.',
  '',
  'Top tech keywords for a 10+ year architect:',
  'WebGPU - browser access to modern GPU compute and rendering pipelines.',
  'CRDT - conflict-free replicated data type for offline-first collaborative state.',
  'eBPF - sandboxed kernel programs used for observability, policy, and networking.',
  'WASM - portable bytecode used to run near-native modules in browsers and edge runtimes.',
].join('\n');

const turns = [
  {
    role: 'assistant' as const,
    text: assistantText,
    ordinal: 1,
    capturedAt: now,
    sourceSelector: '[data-capture-turn]',
  },
] as const;

const annotations = [
  {
    keyword: 'WebGPU',
    note: 'WebGPU: think Vulkan/Metal/Direct3D-style GPU access exposed safely to browser apps.',
  },
  {
    keyword: 'CRDT',
    note: 'CRDT: distributed data structure that converges without a central conflict resolver.',
  },
  {
    keyword: 'eBPF',
    note: 'eBPF: verifier-constrained programs running inside the kernel for safe telemetry hooks.',
  },
  {
    keyword: 'WASM',
    note: 'WASM: compact portable bytecode that lets non-JS modules run in browser or edge hosts.',
  },
] as const;

const workstream = {
  bac_id: 'bac_ws_keyword_annotations',
  revision: 'rev_keyword_annotations',
  title: 'Keyword annotation synthetic',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
};

const thread = {
  bac_id: 'bac_thread_keyword_annotations',
  provider: 'chatgpt' as const,
  threadUrl,
  title: 'HN keyword annotation demo',
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'manual' as const,
  primaryWorkstreamId: workstream.bac_id,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const connectedSettings = {
  companion: { port: companionPort, bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
};

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });
};

const attachCompanionMocks = async (context: BrowserContext): Promise<void> => {
  const savedAnnotations: unknown[] = [];
  await context.route(`http://127.0.0.1:${String(companionPort)}/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    if ((await route.request().headerValue('x-bac-bridge-key')) !== bridgeKey) {
      await fulfillJson(route, 401, {
        title: 'Bridge key missing or invalid.',
        detail: 'Bridge key missing or invalid.',
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/status') {
      await fulfillJson(route, 200, {
        data: { companion: 'running', vault: 'connected', requestId: 'keyword-status' },
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_keyword_settings',
          autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
          defaultPacketKind: 'research',
          defaultDispatchTarget: 'chatgpt',
          screenShareSafeMode: false,
        },
      });
      return;
    }

    if (route.request().method() === 'POST' && url.pathname === '/v1/events') {
      await fulfillJson(route, 201, {
        data: {
          bac_id: 'bac_event_keyword_annotations',
          revision: 'rev_event_keyword_annotations',
          requestId: 'keyword-event',
        },
      });
      return;
    }

    if (route.request().method() === 'POST' && url.pathname === '/v1/threads') {
      await fulfillJson(route, 200, {
        data: {
          bac_id: thread.bac_id,
          revision: 'rev_thread_keyword_annotations',
          requestId: 'keyword-thread',
        },
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/turns') {
      if (url.searchParams.get('threadUrl') !== threadUrl) {
        await fulfillJson(route, 404, { detail: 'Unknown threadUrl.' });
        return;
      }
      await fulfillJson(route, 200, { data: turns });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/annotations') {
      await fulfillJson(route, 200, { data: savedAnnotations });
      return;
    }

    if (route.request().method() === 'POST' && url.pathname === '/v1/annotations') {
      const payloadText = route.request().postData();
      const payload =
        payloadText === null ? {} : (JSON.parse(payloadText) as Record<string, unknown>);
      const annotation = {
        ...payload,
        bac_id: `bac_ann_keyword_${String(savedAnnotations.length + 1)}`,
        createdAt: now,
      };
      savedAnnotations.push(annotation);
      await fulfillJson(route, 201, { data: annotation });
      return;
    }

    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

const chatGptFixtureHtml = (): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ChatGPT keyword annotation fixture</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #fffdf8;
        color: #1f2937;
      }
      main {
        max-width: 840px;
        margin: 0 auto;
        padding: 32px 24px 140px;
      }
      article {
        margin: 18px 0;
        padding: 18px 20px;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        background: #ffffff;
        white-space: pre-line;
        line-height: 1.6;
      }
      article[data-message-author-role="assistant"] {
        border-left: 4px solid #10a37f;
      }
      #sent-messages {
        margin-top: 28px;
        border-top: 1px solid #e5e7eb;
        padding-top: 12px;
      }
      .sent-message {
        margin: 10px 0;
        padding: 12px 14px;
        border-radius: 8px;
        background: #ecfdf5;
        white-space: pre-wrap;
        font-size: 13px;
      }
      .composer-wrap {
        position: fixed;
        left: 50%;
        bottom: 20px;
        transform: translateX(-50%);
        width: min(820px, calc(100vw - 48px));
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 18px;
        padding: 14px 16px;
        box-shadow: 0 14px 44px rgba(15, 23, 42, 0.16);
      }
      #prompt-textarea {
        min-height: 28px;
        outline: none;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <article data-capture-turn data-role="user" data-message-author-role="user">
Ask for a Hacker News article today, then annotate the top tech keywords for architect-level context.
      </article>
      <article data-capture-turn data-role="assistant" data-message-author-role="assistant">${assistantText}</article>
      <section id="sent-messages" aria-label="Submitted chat messages"></section>
      <div class="composer-wrap">
        <div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Message ChatGPT"></div>
      </div>
    </main>
    <script>
      const composer = document.getElementById('prompt-textarea');
      const sentMessages = document.getElementById('sent-messages');
      composer.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        const text = composer.innerText || composer.textContent || '';
        if (text.trim().length === 0) return;
        const node = document.createElement('div');
        node.className = 'sent-message';
        node.textContent = text;
        sentMessages.appendChild(node);
        composer.textContent = '';
      });
    </script>
  </body>
</html>`;

const openChatGptFixture = async (page: Page): Promise<void> => {
  await page.route('https://chatgpt.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: chatGptFixtureHtml(),
    });
  });
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('article[data-message-author-role="assistant"]')).toContainText(
    'WebGPU',
  );
};

test.describe('ChatGPT keyword annotations (synthetic)', () => {
  test('user annotates each HN tech keyword visually and publishes the notes into chat', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context);

      const chatPage = await runtime.context.newPage();
      await openChatGptFixture(chatPage);

      const sidepanel = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [workstream],
        [THREADS_KEY]: [thread],
      });

      await sidepanel.getByRole('tab', { name: 'All threads' }).click();
      const threadRow = sidepanel.locator('.thread').first();
      await threadRow.locator('.thread-name-btn').click();
      await expect(threadRow.locator('.thread-turn-card.thread-turn-assistant')).toBeVisible();

      for (const annotation of annotations) {
        await sidepanel.bringToFront();
        await threadRow.getByRole('button', { name: /annotate/u }).click();
        await sidepanel.getByLabel('Keyword or quote to highlight').fill(annotation.keyword);
        await sidepanel.locator('textarea.thread-turn-annotate-input').fill(annotation.note);
        await threadRow.getByRole('button', { name: 'publish to chat' }).click();
        await expect(threadRow.locator('.thread-turn-annotate-result')).toContainText(
          'marker placed and published to chat',
        );

        await chatPage.bringToFront();
        await expect(chatPage.locator('.sent-message').last()).toContainText(annotation.keyword);
        await expect(chatPage.locator('.sent-message').last()).toContainText(annotation.note);
      }

      await expect(chatPage.locator('.sidetrack-ann-highlight')).toHaveCount(annotations.length);
      const highlightTitles = await chatPage
        .locator('.sidetrack-ann-highlight')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).title));
      expect(highlightTitles).toEqual(annotations.map((annotation) => annotation.keyword));
      await expect(chatPage.locator('.sidetrack-ann-margin')).toHaveCount(annotations.length);
      await expect(chatPage.locator('.sidetrack-ann-hint')).toContainText('4 annotations restored');

      const screenshotPath = test.info().outputPath('chatgpt-keyword-annotations.png');
      await chatPage.screenshot({ path: screenshotPath, fullPage: true });
      await test.info().attach('chatgpt keyword annotations', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await runtime?.close();
    }
  });
});
