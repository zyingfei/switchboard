import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { buildAnchorFromTerm } from '../../../sidetrack-companion/src/annotation/anchorBuilder.js';
import {
  listAnnotations as listStoredAnnotations,
  writeAnnotation,
} from '../../../sidetrack-companion/src/vault/annotationStore.js';
import type { DispatchEventRecord } from '../../../sidetrack-companion/src/http/schemas.js';
import { messageTypes } from '../../src/messages';
import { createMockVaultCompanion, type MockVaultCompanion } from './helpers/mockVaultCompanion';
import { startInProcessMcp, type InProcessMcp } from './helpers/inProcessMcp';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, WORKSTREAMS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';

const now = '2026-05-05T12:00:00.000Z';
const finalPath = '/c/hn-top-article-analysis';
const finalUrl = `https://chatgpt.com${finalPath}`;
const pageTitle = 'ChatGPT HN article analysis';
const dispatchId = 'bac_dispatch_hn_mcp_annotation';

const dispatchBody = [
  "Use today's Hacker News top article as the source.",
  'Write a full analysis in a new ChatGPT thread.',
  'Make it section by section and detailed.',
  "Then identify the top technical keywords that a 10+ year software architect should understand, especially if they are new open source or outside the architect's usual domain.",
].join('\n');

const assistantText = [
  "Hacker News top article selected for today's reader brief: a WebGPU-powered browser runtime for local-first AI tools.",
  '',
  'Section 1 - Why the article matters',
  'The article argues that serious AI tooling is moving from server-only dashboards into browser-resident workspaces. WebGPU is the enabling substrate because it exposes modern GPU compute and rendering without a native installer.',
  '',
  'Section 2 - System architecture',
  'The proposed architecture keeps the UI, queue, and annotation model in the browser, while a lightweight local companion persists state. WASM modules handle portable parsing and indexing, so the same code can run in browser, edge, and local companion contexts.',
  '',
  'Section 3 - Collaboration and state',
  'The article uses a CRDT document model to merge edits from multiple sessions without central conflict resolution. That matters when an architect wants offline-first workspaces with deterministic convergence.',
  '',
  'Section 4 - Operations and observability',
  'The infrastructure section mentions eBPF probes for low-overhead network and kernel observability. The important point is that runtime visibility can be collected without turning every service into a bespoke metrics emitter.',
  '',
  'Section 5 - Architect readout',
  'The core tradeoff is control versus portability. WebGPU and WASM reduce native installation friction, CRDTs reduce collaboration coordination, and eBPF shifts some observability below the application layer.',
].join('\n');

const termAnnotations = [
  {
    term: 'WebGPU',
    note: 'WebGPU: browser GPU compute/rendering API, roughly the web-facing successor mindset to Vulkan/Metal-class access.',
  },
  {
    term: 'WASM',
    note: 'WASM: portable bytecode for running non-JavaScript modules in browser, edge, and local runtimes.',
  },
  {
    term: 'CRDT',
    note: 'CRDT: conflict-free replicated data type for offline-first collaboration that converges without a central merge coordinator.',
  },
  {
    term: 'eBPF',
    note: 'eBPF: verifier-constrained programs in the kernel, commonly used for low-overhead observability and networking policy.',
  },
] as const;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeJson = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

const contextForTerm = (
  text: string,
  term: string,
): { readonly prefix: string; readonly suffix: string } => {
  const index = text.indexOf(term);
  if (index < 0) {
    throw new Error(`Term not found in assistant text: ${term}`);
  }
  return {
    prefix: text.slice(Math.max(0, index - 32), index),
    suffix: text.slice(index + term.length, index + term.length + 32),
  };
};

const conversationArticles = (): string => `
      <article data-capture-turn data-role="user" data-message-author-role="user">${escapeHtml(dispatchBody)}</article>
      <article data-capture-turn data-role="assistant" data-message-author-role="assistant">${escapeHtml(assistantText)}</article>`;

const chatGptFixtureHtml = (preloadedConversation: boolean): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${preloadedConversation ? pageTitle : 'ChatGPT'}</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8fafc;
        color: #111827;
      }
      main {
        max-width: 880px;
        margin: 0 auto;
        padding: 32px 24px 144px;
      }
      article {
        margin: 16px 0;
        padding: 18px 20px;
        border: 1px solid #d8dee8;
        border-radius: 8px;
        background: #ffffff;
        white-space: pre-line;
        line-height: 1.6;
      }
      article[data-message-author-role="assistant"] {
        border-left: 4px solid #0f766e;
      }
      .composer-wrap {
        position: fixed;
        left: 50%;
        bottom: 20px;
        transform: translateX(-50%);
        width: min(840px, calc(100vw - 48px));
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 18px;
        padding: 14px 16px;
        box-shadow: 0 16px 44px rgba(15, 23, 42, 0.18);
      }
      #prompt-textarea {
        min-height: 32px;
        outline: none;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main id="conversation" aria-label="ChatGPT conversation">
${preloadedConversation ? conversationArticles() : ''}
      <div class="composer-wrap">
        <div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Message ChatGPT"></div>
      </div>
    </main>
    <script type="application/json" id="assistant-answer">${safeJson(assistantText)}</script>
    <script>
      const finalPath = ${JSON.stringify(finalPath)};
      const pageTitle = ${JSON.stringify(pageTitle)};
      const conversation = document.getElementById('conversation');
      const composer = document.getElementById('prompt-textarea');
      const assistantAnswer = JSON.parse(document.getElementById('assistant-answer').textContent);
      const placeCaretAtEnd = () => {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      };
      const appendTurn = (role, text) => {
        const node = document.createElement('article');
        node.setAttribute('data-capture-turn', '');
        node.setAttribute('data-role', role);
        node.setAttribute('data-message-author-role', role);
        node.textContent = text;
        conversation.insertBefore(node, document.querySelector('.composer-wrap'));
      };
      composer.addEventListener('focus', placeCaretAtEnd);
      composer.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        const text = composer.innerText || composer.textContent || '';
        if (text.trim().length === 0) return;
        appendTurn('user', text);
        appendTurn('assistant', assistantAnswer);
        composer.textContent = '';
        document.title = pageTitle;
        history.pushState({}, '', finalPath);
      });
    </script>
  </body>
</html>`;

const routeChatGptFixture = async (context: BrowserContext): Promise<void> => {
  await context.route('https://chatgpt.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: chatGptFixtureHtml(url.pathname === finalPath),
    });
  });
};

const extractPrompt = async (page: Page): Promise<string> =>
  (await page.locator('.coding-handoff-prompt').textContent()) ?? '';

const extractAttachToken = (prompt: string): string => {
  const match = /sidetrack_attach_token:\s*([A-Za-z0-9_-]+)/u.exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error('Attach prompt did not include sidetrack_attach_token.');
  }
  return match[1];
};

const waitForOpenedChatPage = async (context: BrowserContext): Promise<Page> => {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/'));
        return found?.url() ?? '';
      },
      { timeout: 30_000 },
    )
    .toContain('https://chatgpt.com/');
  if (found === undefined) {
    throw new Error('ChatGPT page did not open.');
  }
  return found;
};

test.describe('Codex MCP Hacker News annotation flow (synthetic browser)', () => {
  test('generates attach prompt, dispatches ChatGPT analysis, creates term annotations through MCP, and restores them visually', async () => {
    let companion: MockVaultCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    let mcp: InProcessMcp | undefined;

    try {
      companion = await createMockVaultCompanion();
      const seededWorkstream = await companion.writer.createWorkstream(
        {
          title: 'HN MCP annotation e2e',
          privacy: 'shared',
          tags: ['e2e', 'mcp'],
          children: [],
          checklist: [],
        },
        'hn-mcp-annotation-seed',
      );
      const workstream = {
        bac_id: seededWorkstream.bac_id,
        revision: seededWorkstream.revision,
        title: 'HN MCP annotation e2e',
        children: [] as string[],
        tags: ['e2e', 'mcp'],
        checklist: [] as unknown[],
        privacy: 'shared' as const,
        updatedAt: now,
      };

      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await companion.attach(runtime.context);
      await routeChatGptFixture(runtime.context);

      const sidepanel = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: {
          companion: { port: companion.port, bridgeKey: companion.bridgeKey },
          autoTrack: false,
          siteToggles: { chatgpt: true, claude: true, gemini: true },
        },
        [WORKSTREAMS_KEY]: [workstream],
      });

      await sidepanel.getByRole('button', { name: 'Attach coding session' }).click();
      await sidepanel.locator('select').selectOption(workstream.bac_id);
      await sidepanel.getByRole('button', { name: 'Generate prompt' }).click();
      const prompt = await extractPrompt(sidepanel);
      expect(prompt).toContain('sidetrack.session.attach');
      const token = extractAttachToken(prompt);

      const activeCompanion = companion;
      mcp = await startInProcessMcp({
        vaultPath: activeCompanion.vaultPath,
        companionClient: {
          async registerCodingSession(input) {
            return await activeCompanion.writer.registerCodingSession(
              input,
              'hn-mcp-annotation-register',
            );
          },
          async requestDispatch(input) {
            const requestedAt = new Date().toISOString();
            const record: DispatchEventRecord = {
              bac_id: dispatchId,
              kind: 'coding',
              target: { provider: input.targetProvider, mode: input.mode },
              title: input.title,
              body: input.body,
              createdAt: requestedAt,
              redactionSummary: { matched: 0, categories: [] },
              tokenEstimate: Math.ceil(input.body.length / 4),
              status: 'pending',
              ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
              ...(input.sourceThreadId === undefined
                ? {}
                : { sourceThreadId: input.sourceThreadId }),
              mcpRequest: {
                codingSessionId: input.codingSessionId,
                approval: 'auto-approved',
                requestedAt,
              },
            };
            await activeCompanion.writer.writeDispatchEvent(record, 'hn-mcp-annotation-dispatch');
            return {
              dispatchId,
              approval: 'auto-approved',
              status: 'recorded',
              requestedAt,
            };
          },
          async createAnnotation(input) {
            // Phase 4: the MCP CompanionWriteClient.createAnnotation
            // contract is term-form. Mirror the real companion route:
            // fetch the thread's assistant turns and build the anchor
            // server-side before writing.
            const threadUrl = input.threadUrl ?? input.url;
            const turns = await activeCompanion.writer.readRecentTurns({
              threadUrl,
              limit: 50,
              role: 'assistant',
            });
            if (turns.length === 0) {
              throw new Error(`No assistant turns found for ${threadUrl}.`);
            }
            const turnText = turns
              .slice()
              .sort((left, right) => left.ordinal - right.ordinal)
              .map((turn) => turn.text)
              .join('\n\n');
            const anchor = buildAnchorFromTerm({
              turnText,
              term: input.term,
              ...(input.selectionHint === undefined ? {} : { selectionHint: input.selectionHint }),
            });
            return {
              ...(await writeAnnotation(activeCompanion.vaultPath, {
                url: input.url,
                pageTitle: input.pageTitle,
                anchor,
                note: input.note,
              })),
            };
          },
          async listAnnotations(input) {
            const annotations = await listStoredAnnotations(activeCompanion.vaultPath, {
              ...(input.url === undefined ? {} : { url: input.url }),
            });
            return input.limit === undefined ? annotations : annotations.slice(0, input.limit);
          },
          async createQueueItem(input) {
            return await activeCompanion.writer.createQueueItem(input, 'hn-mcp-annotation-queue');
          },
        },
      });

      expect(await mcp.listTools()).toEqual(
        expect.arrayContaining([
          'sidetrack.session.attach',
          'sidetrack.dispatch.create',
          'sidetrack.annotations.create_batch',
          'sidetrack.annotations.list',
        ]),
      );

      const registered = (await mcp.callTool('sidetrack.session.attach', {
        attachToken: token,
        tool: 'codex',
        cwd: '/Users/zyingfei/switchboard',
        branch: 'codex/visual-keyword-annotation-e2e',
        sessionId: 'hn-mcp-annotation-browser',
        name: 'codex - HN MCP annotation e2e',
      })) as { readonly structuredContent?: { readonly codingSessionId?: string } };
      const codingSessionId = registered.structuredContent?.codingSessionId;
      expect(codingSessionId).toBeTruthy();

      const workstreamData = (await mcp.callTool('sidetrack.workstreams.get', {
        id: workstream.bac_id,
      })) as { readonly structuredContent?: unknown };
      expect(JSON.stringify(workstreamData.structuredContent)).toContain('HN MCP annotation e2e');

      const contextPack = (await mcp.callTool('sidetrack.workstreams.context_pack', {
        workstreamId: workstream.bac_id,
      })) as { readonly structuredContent?: unknown };
      expect(JSON.stringify(contextPack.structuredContent)).toContain('HN MCP annotation e2e');

      const requested = (await mcp.callTool('sidetrack.dispatch.create', {
        codingSessionId,
        targetProvider: 'chatgpt',
        title: 'HN top article full analysis',
        body: dispatchBody,
      })) as {
        readonly structuredContent?: {
          readonly dispatchId?: string;
          readonly approval?: string;
          readonly workstreamId?: string;
        };
      };
      expect(requested.structuredContent).toMatchObject({
        dispatchId,
        approval: 'auto-approved',
        workstreamId: workstream.bac_id,
      });

      await runtime.sendRuntimeMessage(sidepanel, { type: messageTypes.getWorkboardState });
      const chatPage = await waitForOpenedChatPage(runtime.context);
      await chatPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => chatPage.url(), { timeout: 50_000 }).toBe(finalUrl);
      await expect(chatPage.locator('article[data-message-author-role="assistant"]')).toContainText(
        'Section 5 - Architect readout',
      );
      await expect(chatPage.locator('article[data-message-author-role="user"]')).toContainText(
        "Use today's Hacker News top article",
      );

      await expect
        .poll(
          async () => {
            const turns = await activeCompanion.writer.readRecentTurns({
              threadUrl: finalUrl,
              limit: 5,
            });
            return turns.map((turn) => turn.text).join('\n\n');
          },
          { timeout: 30_000 },
        )
        .toContain('WebGPU and WASM reduce native installation friction');

      await expect
        .poll(
          async () => {
            const storage = await sidepanel.evaluate(async () => {
              return await chrome.storage.local.get(['sidetrack.dispatchLinks']);
            });
            const links = storage['sidetrack.dispatchLinks'] as Record<string, string> | undefined;
            return links?.[dispatchId] ?? '';
          },
          { timeout: 15_000 },
        )
        .not.toBe('');
      const storage = await sidepanel.evaluate(async () => {
        return await chrome.storage.local.get(['sidetrack.dispatchLinks']);
      });
      const links = storage['sidetrack.dispatchLinks'] as Record<string, string>;
      const linkedThreadId = links[dispatchId];
      expect(linkedThreadId).toBeTruthy();

      // Phase 4: agent passes intent only (term + note + optional
      // selectionHint). The companion's anchor builder fetches the
      // thread's assistant turns from the vault and computes the
      // prefix/suffix windows server-side.
      void contextForTerm; // kept above for any test debugging needs
      const batchItems = termAnnotations.map((annotation) => ({
        term: annotation.term,
        note: annotation.note,
      }));
      await mcp.callTool('sidetrack.annotations.create_batch', {
        url: finalUrl,
        pageTitle,
        items: batchItems,
      });

      const listed = (await mcp.callTool('sidetrack.annotations.list', {
        url: finalUrl,
        limit: 10,
      })) as { readonly structuredContent?: { readonly data?: readonly unknown[] } };
      expect(listed.structuredContent?.data).toHaveLength(termAnnotations.length);

      await mcp.callTool('sidetrack.queue.create', {
        scope: 'thread',
        targetId: linkedThreadId,
        text: 'Follow up on the annotated HN analysis thread and check whether the WebGPU/WASM tradeoffs need a deeper security note.',
      });

      // Real user flow: the chat tab the dispatch auto-opened (chatPage)
      // is still rendering the user/assistant articles. Activate it,
      // ask the side panel to re-capture (the same call that fires
      // when the user clicks the side-panel capture icon), and the
      // content script's restore path will pick up the four MCP
      // annotations and mount visible highlights — without ever
      // opening a second tab.
      const dispatchedTabUrl = await sidepanel.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find((tab) => tab.url === url);
        if (typeof target?.id === 'number') {
          await chrome.tabs.update(target.id, { active: true });
        }
        return target?.url ?? '';
      }, finalUrl);
      expect(dispatchedTabUrl).toBe(finalUrl);
      expect(chatPage.url()).toBe(finalUrl);
      const captureResponse = await runtime.sendRuntimeMessage(sidepanel, {
        type: messageTypes.captureCurrentTab,
      });
      expect(captureResponse).toMatchObject({ ok: true });
      // Note: we deliberately don't gate on data-sidetrack-provider-canary
      // here. That attribute is set once at content-script boot (~1.2s
      // after page load) and reflects whatever capture state existed
      // then. On the dispatched tab, the script booted before the
      // assistant article was rendered, so the canary stays 'failed'
      // forever. The earlier turn-readback poll already proved capture
      // works on this tab; the highlight-count assertion below is the
      // real proof that restore fired and rendered.
      // Restore is triggered inside the captureVisibleThread handler;
      // the response above resolves once the content script has both
      // re-captured turns AND requested the latest annotations from
      // the companion. The four highlights mount on the same chat tab
      // the agent dispatched into.
      await expect(chatPage.locator('.sidetrack-ann-highlight')).toHaveCount(
        termAnnotations.length,
        { timeout: 10_000 },
      );
      const highlightTitles = await chatPage
        .locator('.sidetrack-ann-highlight')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).title));
      expect([...highlightTitles].sort()).toEqual(
        [...termAnnotations.map((annotation) => annotation.term)].sort(),
      );
      await expect(chatPage.locator('.sidetrack-ann-margin')).toHaveCount(
        termAnnotations.length,
      );
      await expect(chatPage.locator('.sidetrack-ann-hint')).toContainText(
        `${String(termAnnotations.length)} annotations restored`,
      );

      // Scroll the live page and confirm the highlight stays glued to
      // its underlying text — guards against the "fixed-positioned
      // overlay drifts when the page scrolls" regression we just fixed
      // in contentOverlays. Note: the reposition handler re-mounts
      // highlight DOM nodes on each scroll, so we re-query for the
      // current node after scroll instead of caching a reference that
      // would become detached.
      const drift = await chatPage.evaluate(async () => {
        const annId = document
          .querySelector('.sidetrack-ann-highlight')
          ?.getAttribute('data-ann-id');
        if (annId === null || annId === undefined) return { failed: true } as const;
        const sampleSelector = `.sidetrack-ann-highlight[data-ann-id="${annId}"]`;
        const before = document.querySelector(sampleSelector)?.getBoundingClientRect();
        const article = document.querySelector('article[data-message-author-role="assistant"]');
        const beforeText = article?.getBoundingClientRect();
        if (before === undefined || beforeText === undefined) return { failed: true } as const;
        window.scrollBy({ top: 200, behavior: 'instant' as ScrollBehavior });
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve(undefined);
          });
        });
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve(undefined);
          });
        });
        const afterEl = document.querySelector(sampleSelector);
        const after = afterEl?.getBoundingClientRect();
        const afterText = article?.getBoundingClientRect();
        if (after === undefined || afterText === undefined) return { failed: true } as const;
        return {
          failed: false,
          highlightDelta: after.top - before.top,
          textDelta: afterText.top - beforeText.top,
        } as const;
      });
      expect(drift.failed).toBe(false);
      if (!drift.failed) {
        // Highlight should track the underlying article rect within a
        // few pixels — both move together when the viewport scrolls.
        // Without the scroll-tracking fix, highlightDelta stayed at 0
        // while textDelta hit roughly -200.
        expect(Math.abs(drift.highlightDelta - drift.textDelta)).toBeLessThanOrEqual(2);
      }

      // Scroll back so the screenshot captures the canonical first-fold
      // view, then attach the artifact. The HTML report shows this image
      // as the proof of "annotated chat page left visible to the user".
      await chatPage.evaluate(() => {
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      });
      await chatPage.waitForTimeout(50);
      const screenshotPath = test.info().outputPath('codex-hn-mcp-annotation.png');
      await chatPage.screenshot({ path: screenshotPath, fullPage: true });
      await test.info().attach('codex HN MCP annotation', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } finally {
      await mcp?.close();
      await runtime?.close();
      await companion?.close();
    }
  });
});
