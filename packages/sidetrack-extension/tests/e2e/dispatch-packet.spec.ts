import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-04-29T12:00:00.000Z';
const companionPort = 17_373;
const bridgeKey = 'dispatch_packet_bridge_key_012345678901234567890123';
const threadUrl = 'https://claude.ai/chat/dispatch-packet-synthetic';

const turns = [
  {
    role: 'user' as const,
    text: 'Summarize the prior debugging work and keep the acceptance criteria explicit.',
    ordinal: 0,
    capturedAt: '2026-04-29T11:50:00.000Z',
  },
  {
    role: 'assistant' as const,
    text: 'The bug was narrowed to the packet composer token preview and the turn selector.',
    ordinal: 1,
    capturedAt: '2026-04-29T11:51:00.000Z',
  },
  {
    role: 'user' as const,
    text: 'Also capture the risk that the companion fetch may be unavailable in local-only mode.',
    ordinal: 2,
    capturedAt: '2026-04-29T11:52:00.000Z',
  },
  {
    role: 'assistant' as const,
    text: 'Noted. I will include the fallback behavior and the explicit network assumptions.',
    ordinal: 3,
    capturedAt: '2026-04-29T11:53:00.000Z',
  },
  {
    role: 'user' as const,
    text: 'The final packet should mention the sidepanel selectors we used for verification.',
    ordinal: 4,
    capturedAt: '2026-04-29T11:54:00.000Z',
  },
  {
    role: 'assistant' as const,
    text: 'I will call out the slider row, packet body textarea, and token pill in the summary.',
    ordinal: 5,
    capturedAt: '2026-04-29T11:55:00.000Z',
  },
] as const;

const workstream = {
  bac_id: 'bac_ws_dispatch_packet',
  revision: 'rev_dispatch_packet',
  title: 'Dispatch packet synthetic',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
};

const thread = {
  bac_id: 'bac_thread_dispatch_packet',
  provider: 'claude' as const,
  threadUrl,
  title: 'Dispatch packet host thread',
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'manual' as const,
  primaryWorkstreamId: workstream.bac_id,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const connectedSettings = {
  companion: {
    port: companionPort,
    bridgeKey,
  },
  autoTrack: false,
  siteToggles: {
    chatgpt: true,
    claude: true,
    gemini: true,
  },
};

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });
};

const attachCompanionMocks = async (context: BrowserContext): Promise<void> => {
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
        data: {
          companion: 'running',
          vault: 'connected',
          requestId: 'dispatch-packet-status',
        },
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_dispatch_settings',
          autoSendOptIn: {
            chatgpt: false,
            claude: false,
            gemini: false,
          },
          defaultPacketKind: 'research',
          defaultDispatchTarget: 'claude',
          screenShareSafeMode: false,
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

    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

const getTokenCount = async (page: Page): Promise<number> => {
  const tokenText = await page.locator('.token-pill .mono').first().innerText();
  const match = /^([\d,]+)\s*\/\s*[\d,]+\s+tokens$/u.exec(tokenText.trim());
  if (match === null) {
    throw new Error(`Could not parse token count from "${tokenText}".`);
  }
  return Number(match[1].replaceAll(',', ''));
};

const setSliderValue = async (page: Page, value: number): Promise<void> => {
  const slider = page.locator('.slider-row input[type="range"]');
  // React tracks input value via its own descriptor — direct
  // input.value = X does NOT trigger onChange. Use the native setter so
  // React's synthetic event dispatch picks up the new value.
  await slider.evaluate(
    (element, nextValue) => {
      const input = element as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      if (descriptor?.set !== undefined) {
        descriptor.set.call(input, String(nextValue));
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
};

test.describe('dispatch packet (synthetic)', () => {
  test('template selection, last-N slider, token heuristic, and cancel all work via the sidepanel UI', async () => {
    let runtime: ExtensionRuntime | undefined;

    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context);

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [workstream],
        [THREADS_KEY]: [thread],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();
      // companionStatusLabel('connected') is "vault: synced" — see
      // src/workboard.ts.
      await expect(page.locator('.ws-status')).toHaveText('vault: synced');

      const captureResponse = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl,
          title: thread.title,
          capturedAt: now,
          turns,
        },
      });
      assertOk(captureResponse);

      const threadRow = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: thread.title }) });
      await threadRow.getByRole('button', { name: 'Send' }).click();

      const modal = page.locator('.modal').filter({ has: page.getByRole('heading', { name: 'New packet' }) });
      await expect(modal).toBeVisible();
      // Wait for the turns fetch to land — the indicator's denominator
      // becomes 6 once availableTurns populates. The numerator (initial
      // includeTurnCount) is racy with the fetch landing, so we don't
      // assert on the default — we explicitly drive it below.
      await expect(modal.locator('.slider-row .mono')).toHaveText(/^\d+ \/ 6 turns$/u);

      const body = modal.locator('.packet-body-input');
      // The default research template is web_to_ai_checklist — assert the
      // body initialises to that template's content. (Driving every
      // template button in a loop turned out racy with the body-regen
      // useEffect; covered by unit tests in components.test.tsx instead.)
      await expect(body).toHaveValue(/Pre-flight checklist for the receiving AI/u);
      // All four template buttons should at least be present + clickable.
      for (const buttonName of [
        'Web-to-AI checklist',
        'Resume → tech-stack',
        'Latest developments radar',
        'Custom',
      ]) {
        await expect(modal.getByRole('button', { name: buttonName })).toBeVisible();
      }

      // Drive the slider through three positions; assert (a) indicator
      // updates, (b) token count matches the same char/4 heuristic the
      // production composer uses, (c) more turns → more tokens.
      await setSliderValue(page, 0);
      await expect(modal.locator('.slider-row .mono')).toHaveText('0 / 6 turns');
      const bodyAtZeroTurns = await body.inputValue();
      const tokenAtZeroTurns = await getTokenCount(page);
      expect(tokenAtZeroTurns).toBe(estimateTokens(bodyAtZeroTurns));

      await setSliderValue(page, 4);
      await expect(modal.locator('.slider-row .mono')).toHaveText('4 / 6 turns');
      const bodyAtFourTurns = await body.inputValue();
      const tokenAtFourTurns = await getTokenCount(page);
      expect(tokenAtFourTurns).toBe(estimateTokens(bodyAtFourTurns));

      await setSliderValue(page, 6);
      await expect(modal.locator('.slider-row .mono')).toHaveText('6 / 6 turns');
      const bodyAtSixTurns = await body.inputValue();
      const tokenAtSixTurns = await getTokenCount(page);
      expect(tokenAtSixTurns).toBe(estimateTokens(bodyAtSixTurns));

      expect(tokenAtZeroTurns).toBeLessThan(tokenAtFourTurns);
      expect(tokenAtFourTurns).toBeLessThan(tokenAtSixTurns);

      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('.modal')).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });
});
