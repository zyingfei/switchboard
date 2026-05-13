import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { canonicalThreadUrl } from '../../src/capture/providerDetection';
import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { installLlmNetworkMock, type LlmNetworkMock } from './helpers/llm-network-mock';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

const CODEX_COLLECTOR_ID = 'sidetrack.codex-cli';
const DISPATCH_SNIPPET =
  'copy.fail CVE-2026-31431 Linux crypto subsystem repro notes for VM validation';

type FlowKey = 'security' | 'switchboard';

interface VisitFixture {
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly flow: FlowKey;
}

const SECURITY_VISITS = [
  {
    url: 'https://news.ycombinator.com/item?id=47952181',
    title: 'HN discussion: copy-fail Linux distributions',
    body: 'HN thread collecting copy.fail Linux distro impact and exploit discussion.',
    flow: 'security',
  },
  {
    url: 'https://xint.io/blog/copy-fail-linux-distributions',
    title: 'copy-fail across Linux distributions',
    body: 'copy.fail Linux distributions analysis for the crypto subsystem failure mode.',
    flow: 'security',
  },
  {
    url: 'https://www.google.com/search?q=Linux+crypto+subsystem',
    title: 'Google search: Linux crypto subsystem',
    body: 'Search results for Linux crypto subsystem references relevant to copy.fail.',
    flow: 'security',
  },
  {
    url: 'https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd',
    title: 'ChatGPT analysis: copy-fail research thread',
    body: 'ChatGPT thread analyzing copy.fail Linux crypto subsystem impact.',
    flow: 'security',
  },
  {
    url: 'https://copy.fail/',
    title: 'copy.fail vulnerability landing page',
    body: DISPATCH_SNIPPET,
    flow: 'security',
  },
  {
    url: 'https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py',
    title: 'copy_fail_exp.py coding-agent VM target',
    body: 'GitHub exploit file page with a coding-agent input for VM validation.',
    flow: 'security',
  },
] as const satisfies readonly VisitFixture[];

const SWITCHBOARD_VISITS = [
  {
    url: 'https://github.com/zyingfei/switchboard',
    title: 'Switchboard repository',
    body: 'Switchboard repository review for Sidetrack PR follow-up.',
    flow: 'switchboard',
  },
  {
    url: 'https://github.com/zyingfei/switchboard/pulls',
    title: 'Switchboard pull requests',
    body: 'Open Switchboard pull requests for Stage 4 review.',
    flow: 'switchboard',
  },
  {
    url: 'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae-switchboard/c/69fd259a-83b0-8326-a4d9-c4c1b76a5986',
    title: 'ChatGPT Switchboard project analysis',
    body: 'ChatGPT project thread reviewing Switchboard PR status and requirements.',
    flow: 'switchboard',
  },
  {
    url: 'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69fcb926-3a98-8328-bbe4-baee4da7fbef',
    title: 'ChatGPT sibling analysis thread',
    body: 'Second ChatGPT thread running alongside the Switchboard PR review.',
    flow: 'switchboard',
  },
  {
    url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
    title: 'YouTube ambient Switchboard context',
    body: 'Ambient YouTube analysis opened while the Switchboard workstream stays active.',
    flow: 'switchboard',
  },
  {
    url: 'https://gemini.google.com/app/7a97310e824ccad4?hl=en-US',
    title: 'Gemini Switchboard analysis',
    body: 'Gemini analysis running in parallel with the Switchboard PR review.',
    flow: 'switchboard',
  },
] as const satisfies readonly VisitFixture[];

const VISITS = [...SECURITY_VISITS, ...SWITCHBOARD_VISITS] as const;
const ALL_URLS = VISITS.map((visit) => visit.url);
const GOOGLE_HOME_URL = 'https://www.google.com/';
const CHRONOX_AF_ALG_URL = 'https://www.chronox.de/libkcapi/html/ch01s02.html';
const SWITCHBOARD_PR_110_URL = 'https://github.com/zyingfei/switchboard/pull/110';
const SWITCHBOARD_PR_110_FILES_URL = 'https://github.com/zyingfei/switchboard/pull/110/files';
const REAL_STORY_HOST_PERMISSIONS = [
  'https://news.ycombinator.com/*',
  'https://xint.io/*',
  'https://www.google.com/*',
  'https://www.chronox.de/*',
  'https://chatgpt.com/*',
  'https://github.com/*',
  'https://copy.fail/*',
  'https://www.youtube.com/*',
  'https://gemini.google.com/*',
] as const;
const HOLD_OPEN_ON_CONNECTIONS = process.env['SIDETRACK_E2E_HOLD_OPEN'] === '1';

interface ConnectionNode {
  readonly id: string;
  readonly kind: string;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
}

interface ConnectionEdge {
  readonly id: string;
  readonly kind: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly confidence?: string;
  readonly producedBy?: {
    readonly source?: string;
    readonly revisionId?: string;
    readonly kind?: string;
  };
  readonly metadata?: Record<string, unknown>;
}

interface ConnectionsEnvelope {
  readonly data: {
    readonly snapshot: {
      readonly nodes: readonly ConnectionNode[];
      readonly edges: readonly ConnectionEdge[];
    };
  };
}

interface FeedbackProjectionEnvelope {
  readonly data: {
    readonly positiveLabels: readonly { readonly fromId: string; readonly toId: string }[];
    readonly negativeLabels: readonly { readonly fromId: string; readonly toId: string }[];
  };
}

interface RetrainEnvelope {
  readonly data:
    | {
        readonly status: 'trained';
        readonly revisionId: string;
        readonly candidateCount: number;
      }
    | {
        readonly status: 'skipped' | 'failed';
        readonly reason?: string;
        readonly error?: string;
      };
}

interface CollectorsEnvelope {
  readonly collectors: readonly {
    readonly collector_id: string;
    readonly status: 'loaded' | 'load-failed';
    readonly last_promoted_at: string | null;
    readonly quarantine_count: number;
  }[];
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/u, '');
const normalizeTabLookupUrl = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const visitNodeId = (url: string): string => `timeline-visit:${stripTrailingSlash(url)}`;

const graphVisitNodeId = (url: string): string => visitNodeId(canonicalThreadUrl(url));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasEngagementClass = (node: ConnectionNode): boolean => {
  const engagement = node.metadata?.engagement;
  return (
    node.kind === 'timeline-visit' &&
    isRecord(engagement) &&
    typeof engagement['class'] === 'string'
  );
};

const apiGet = async (comp: TestCompanion, path: string): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    headers: { 'x-bac-bridge-key': comp.bridgeKey },
  });
  if (!res.ok)
    throw new Error(`GET ${path} failed with ${String(res.status)}: ${await res.text()}`);
  return await res.json();
};

const apiPost = async (comp: TestCompanion, path: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${String(comp.port)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': comp.bridgeKey,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed with ${String(res.status)}: ${await res.text()}`);
  }
  return await res.json();
};

const openPrivacyGate = async (comp: TestCompanion, gate: string): Promise<void> => {
  await apiPost(comp, '/v1/privacy/events', {
    type: 'privacy.gate.flipped',
    payload: {
      payloadVersion: 1,
      gate,
      state: 'open',
      actor: 'user',
      reason: 'l5-e2e',
    },
  });
};

const waitForConnections = async (
  comp: TestCompanion,
  predicate: (env: ConnectionsEnvelope) => boolean,
  message: string,
  timeoutMs = 90_000,
): Promise<ConnectionsEnvelope> => {
  const startedMs = Date.now();
  let latest: ConnectionsEnvelope | null = null;
  while (Date.now() - startedMs < timeoutMs) {
    latest = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${message}; latest=${JSON.stringify(latest?.data.snapshot ?? null)}`);
};

const waitForCondition = async (
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 90_000,
): Promise<void> => {
  const startedMs = Date.now();
  while (Date.now() - startedMs < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message);
};

const edgeConnects = (edge: ConnectionEdge, left: string, right: string): boolean =>
  (edge.fromNodeId === left && edge.toNodeId === right) ||
  (edge.fromNodeId === right && edge.toNodeId === left);

const topContributionCount = (edge: ConnectionEdge): number => {
  const raw = edge.metadata?.topContributions;
  return Array.isArray(raw) ? raw.length : 0;
};

const feedbackCapableEdges = (env: ConnectionsEnvelope): readonly ConnectionEdge[] =>
  env.data.snapshot.edges.filter(
    (edge) =>
      edge.kind === 'closest_visit' ||
      edge.kind === 'visit_resembles_visit' ||
      edge.kind === 'visit_continues_visit',
  );

const hasVisitWorkstreamAttribution = (
  env: ConnectionsEnvelope,
  visit: VisitFixture,
  workstreamId: string,
): boolean => {
  const nodeId = graphVisitNodeId(visit.url);
  const node = env.data.snapshot.nodes.find((candidate) => candidate.id === nodeId);
  return (
    node?.metadata?.workstreamId === workstreamId &&
    env.data.snapshot.edges.some(
      (edge) =>
        edge.kind === 'visit_in_workstream' &&
        edge.fromNodeId === nodeId &&
        edge.toNodeId === `workstream:${workstreamId}`,
    )
  );
};

const hasStoryWorkstreamAttribution = (
  env: ConnectionsEnvelope,
  input: {
    readonly securityWorkstreamId: string;
    readonly switchboardWorkstreamId: string;
  },
): boolean =>
  SECURITY_VISITS.every((visit) =>
    hasVisitWorkstreamAttribution(env, visit, input.securityWorkstreamId),
  ) &&
  SWITCHBOARD_VISITS.every((visit) =>
    hasVisitWorkstreamAttribution(env, visit, input.switchboardWorkstreamId),
  );

const postFlowFeedback = async (
  comp: TestCompanion,
  input: {
    readonly choice: 'confirm' | 'reject';
    readonly relationKind: 'closest_visit' | 'visit_resembles_visit' | 'visit_continues_visit';
    readonly fromId: string;
    readonly toId: string;
  },
): Promise<void> => {
  await apiPost(comp, '/v1/feedback/events', {
    type: input.choice === 'confirm' ? 'user.flow.confirmed' : 'user.flow.rejected',
    payload: {
      payloadVersion: 1,
      relationKind: input.relationKind,
      fromId: input.fromId,
      toId: input.toId,
      ...(input.choice === 'reject' ? { reason: 'not-related' } : {}),
    },
  });
};

const postBootstrapFeedbackLabels = async (
  comp: TestCompanion,
): Promise<{
  readonly positive: { readonly fromId: string; readonly toId: string };
  readonly negative: { readonly fromId: string; readonly toId: string };
}> => {
  const positive = {
    fromId: graphVisitNodeId(SECURITY_VISITS[0].url),
    toId: graphVisitNodeId(SECURITY_VISITS[1].url),
  };
  const secondPositive = {
    fromId: graphVisitNodeId(SECURITY_VISITS[0].url),
    toId: graphVisitNodeId(SECURITY_VISITS[2].url),
  };
  const negative = {
    fromId: graphVisitNodeId(SECURITY_VISITS[0].url),
    toId: graphVisitNodeId(SWITCHBOARD_VISITS[4].url),
  };
  const secondNegative = {
    fromId: graphVisitNodeId(SECURITY_VISITS[0].url),
    toId: graphVisitNodeId(SWITCHBOARD_VISITS[5].url),
  };
  for (const pair of [positive, secondPositive]) {
    await postFlowFeedback(comp, {
      choice: 'confirm',
      relationKind: 'closest_visit',
      ...pair,
    });
  }
  for (const pair of [negative, secondNegative]) {
    await postFlowFeedback(comp, {
      choice: 'reject',
      relationKind: 'closest_visit',
      ...pair,
    });
  }
  return { positive, negative };
};

const clickVisibleEdge = async (panel: Page, edge: ConnectionEdge): Promise<void> => {
  const row = panel.getByTestId(`edge-${edge.id}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(panel.getByTestId('edge-provenance')).toHaveAttribute('data-edge-id', edge.id, {
    timeout: 10_000,
  });
};

const setConnectionsAnchor = async (panel: Page, anchorId: string, hops = '2'): Promise<void> => {
  const select = panel.getByTestId('connections-workstream-select');
  const canUseWorkstreamSelect =
    anchorId.startsWith('workstream:') &&
    (await select.locator(`option[value="${anchorId}"]`).count()) > 0;
  if (canUseWorkstreamSelect) {
    await select.selectOption(anchorId);
  } else {
    const advanced = panel.getByTestId('connections-advanced-anchor');
    const advancedOpen = await advanced.evaluate(
      (node) => node instanceof HTMLDetailsElement && node.open,
    );
    if (!advancedOpen) await panel.getByTestId('connections-advanced-anchor-summary').click();
    const input = panel.getByTestId('connections-anchor-input');
    await input.click();
    await input.fill(anchorId);
    await input.press('Enter');
  }
  await panel.getByTestId('connections-hops-select').selectOption(hops);
  await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
};

const assertRuntimeState = (response: unknown) => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.state;
};

const createWorkstreamThroughExtension = async (
  runtime: ExtensionRuntime,
  panel: Page,
  input: { readonly title: string },
): Promise<string> => {
  const state = assertRuntimeState(
    await runtime.sendRuntimeMessage(panel, {
      type: messageTypes.createWorkstream,
      workstream: {
        title: input.title,
        privacy: 'shared',
      },
    }),
  );
  const workstream = state.workstreams.find((candidate) => candidate.title === input.title);
  if (workstream === undefined) {
    throw new Error(`Created workstream ${input.title} was not returned in extension state.`);
  }
  if (workstream.revision.startsWith('local_')) {
    throw new Error(
      `Created workstream ${input.title} stayed local-only instead of using the companion sync path.`,
    );
  }
  return workstream.bac_id;
};

const extensionHasWorkstreams = async (
  runtime: ExtensionRuntime,
  panel: Page,
  workstreamIds: readonly string[],
): Promise<boolean> => {
  const state = assertRuntimeState(
    await runtime.sendRuntimeMessage(panel, {
      type: messageTypes.getWorkboardState,
    }),
  );
  return workstreamIds.every((id) =>
    state.workstreams.some((candidate) => candidate.bac_id === id),
  );
};

const expectWorkstreamSelectorOptions = async (
  panel: Page,
  workstreams: readonly { readonly id: string; readonly title: string }[],
): Promise<void> => {
  const select = panel.getByTestId('connections-workstream-select');
  for (const workstream of workstreams) {
    await expect(select.locator(`option[value="workstream:${workstream.id}"]`)).toHaveText(
      workstream.title,
      { timeout: 30_000 },
    );
  }
};

const holdOpenOnConnectionsView = async ({
  panel,
  runtime,
  companion,
  securityWorkstreamId,
  switchboardWorkstreamId,
}: {
  readonly panel: Page;
  readonly runtime: ExtensionRuntime;
  readonly companion: TestCompanion;
  readonly securityWorkstreamId: string;
  readonly switchboardWorkstreamId: string;
}): Promise<void> => {
  if (!HOLD_OPEN_ON_CONNECTIONS) return;

  await panel.getByTestId('connections-mode-linked').click();
  await setConnectionsAnchor(panel, `workstream:${switchboardWorkstreamId}`, '4');
  await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
  await panel.bringToFront();

  console.log('[sidetrack hold-open] Browser B Connections panel is open.');
  console.log(
    `[sidetrack hold-open] Extension: chrome-extension://${runtime.extensionId}/sidepanel.html`,
  );
  console.log(`[sidetrack hold-open] Companion: http://127.0.0.1:${companion.port}`);
  console.log(`[sidetrack hold-open] Security workstream: workstream:${securityWorkstreamId}`);
  console.log(
    `[sidetrack hold-open] Switchboard workstream: workstream:${switchboardWorkstreamId}`,
  );
  console.log(
    '[sidetrack hold-open] Press Ctrl+C on the Playwright runner when inspection is done.',
  );

  await new Promise<void>(() => {
    setInterval(() => undefined, 60_000);
  });
};

const openConnectionsPanel = async (
  runtime: ExtensionRuntime,
  comp: TestCompanion,
  activeWorkstreamId?: string,
): Promise<Page> => {
  const panel = await runtime.context.newPage();
  await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await runtime.seedStorage(panel, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: {
      companion: { port: comp.port, bridgeKey: comp.bridgeKey },
      autoTrack: false,
      siteToggles: { chatgpt: true, claude: true, gemini: true },
      notifyOnQueueComplete: true,
    },
    ...(activeWorkstreamId === undefined
      ? {}
      : { 'sidetrack.activeWorkstreamId': activeWorkstreamId }),
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  await panel.getByRole('tab', { name: 'Connections' }).click();
  await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
  return panel;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

const storyHtml = (input: {
  readonly title: string;
  readonly body: string;
  readonly links?: readonly {
    readonly href: string;
    readonly label: string;
    readonly id?: string;
  }[];
  readonly controls?: string;
}): string => `<!doctype html>
<html>
  <head>
    <title>${escapeHtml(input.title)}</title>
    <style>
      body { font: 15px/1.45 system-ui, sans-serif; margin: 32px; max-width: 980px; }
      nav, .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
      a { color: #0b57d0; }
      textarea, input { width: 760px; max-width: 100%; min-height: 44px; display: block; margin: 12px 0; }
      pre { white-space: pre-wrap; background: #f6f8fa; padding: 12px; border-radius: 6px; }
      .spacer { height: 1800px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.title)}</h1>
      <p id="copy-source">${escapeHtml(input.body)}</p>
      <nav>
        ${(input.links ?? [])
          .map(
            (link) =>
              `<a ${link.id === undefined ? '' : `id="${escapeHtml(link.id)}"`} href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
          )
          .join('\n')}
      </nav>
      ${input.controls ?? ''}
      <section id="affected"><h2>Am I affected?</h2><p>The page cache is shared across the host. A pod with the right primitives compromises the node and crosses tenant boundaries.</p></section>
      <section id="exploit"><h2>Exploit</h2><p>Download the public proof of concept and validate it in an isolated VM.</p></section>
      <section id="contact"><h2>Contact</h2><p>Xint Code follow-up and disclosure coordination.</p></section>
      <div class="spacer"></div>
    </main>
  </body>
</html>`;

const pageForPublicUrl = (rawUrl: string): { readonly title: string; readonly body: string } => {
  const url = new URL(rawUrl);
  const requestUrl = stripTrailingSlash(rawUrl);
  const visit = VISITS.find((candidate) => stripTrailingSlash(candidate.url) === requestUrl);
  if (visit !== undefined) {
    return { title: visit.title, body: visit.body };
  }
  if (rawUrl === GOOGLE_HOME_URL) {
    return {
      title: 'Google',
      body: 'Google home page with search box for Linux crypto subsystem.',
    };
  }
  if (url.hostname === 'www.google.com' && url.pathname === '/search') {
    return {
      title: `${url.searchParams.get('q') ?? 'search'} - Google Search`,
      body: 'Search results include ChatGPT analysis, Gemini analysis, and related Linux crypto subsystem references.',
    };
  }
  if (rawUrl === CHRONOX_AF_ALG_URL) {
    return {
      title: 'Purpose Of AF_ALG',
      body: 'AF_ALG exposes the Linux kernel crypto API through sockets and provides background context for copy.fail research.',
    };
  }
  if (rawUrl === SWITCHBOARD_PR_110_URL) {
    return {
      title: 'Stage 4 L5 - full browser sync e2e by zyingfei',
      body: 'PR #110 review body with L5 hardening notes, route realism requirements, and links to analysis surfaces.',
    };
  }
  if (rawUrl === SWITCHBOARD_PR_110_FILES_URL) {
    return {
      title: 'Files changed - Stage 4 L5 full browser sync e2e',
      body: 'Files changed for the L5 Playwright e2e and runtime helpers.',
    };
  }
  return {
    title: `${url.hostname} context`,
    body: `Context page for ${rawUrl}`,
  };
};

const fixtureBodyForUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  const page = pageForPublicUrl(rawUrl);

  if (url.hostname === 'news.ycombinator.com') {
    return storyHtml({
      ...page,
      links: [
        { href: 'https://copy.fail/', label: 'Copy Fail' },
        { href: CHRONOX_AF_ALG_URL, label: CHRONOX_AF_ALG_URL },
      ],
      controls:
        '<p>HN comments discuss AF_ALG, Linux distro coverage, exploit shape, and VM safety.</p>',
    });
  }

  if (url.hostname === 'copy.fail') {
    return storyHtml({
      ...page,
      links: [
        { href: 'https://xint.io/blog/copy-fail-linux-distributions', label: 'Read the write-up' },
        { href: 'https://copy.fail/#exploit', label: 'Get the exploit' },
        {
          href: 'https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py',
          label: 'Download (GitHub)',
        },
        { href: 'https://copy.fail/#affected', label: 'Am I affected?' },
        { href: 'https://copy.fail/#contact', label: 'Contact' },
        { href: 'https://xint.io/', label: 'Xint Code' },
      ],
      controls: `<pre>${escapeHtml(DISPATCH_SNIPPET)}</pre>`,
    });
  }

  if (url.hostname === 'xint.io') {
    return storyHtml({
      ...page,
      links: [
        {
          href: 'https://xint.io/blog/copy-fail-linux-distributions#what-makes-copy-fail-different-0',
          label: 'What Makes Copy Fail Different',
        },
        { href: 'https://copy.fail/', label: 'Copy Fail' },
      ],
      controls:
        '<p>Write-up sections cover distro impact, AF_ALG primitives, and the 732-byte exploit path.</p>',
    });
  }

  if (url.hostname === 'www.google.com' && url.pathname === '/') {
    return storyHtml({
      ...page,
      controls:
        '<form action="/search" method="get"><label>Search <input aria-label="Search" name="q" autofocus /></label><button type="submit">Google Search</button></form>',
    });
  }

  if (url.hostname === 'www.google.com' && url.pathname === '/search') {
    const q = url.searchParams.get('q') ?? '';
    return storyHtml({
      ...page,
      links: q.includes('Ranking')
        ? [
            {
              href: 'https://sease.io/information-retrieval-mini-training/train-evaluate-explain-your-learning-to-rank-model',
              label: 'How to Train, Evaluate and Explain your Learning to Rank Model',
            },
            {
              href: 'https://www.youtube.com/watch?v=rT7G57vto0o&t=122',
              label: 'How we scaled ranking with Learn-to-Rank - Zachary Nickerson',
            },
          ]
        : [
            {
              href: 'https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd',
              label: 'ChatGPT copy-fail analysis',
            },
            { href: CHRONOX_AF_ALG_URL, label: 'Purpose Of AF_ALG' },
          ],
      controls: `<p>Query: ${escapeHtml(q)}</p>`,
    });
  }

  if (url.hostname === 'chatgpt.com') {
    return storyHtml({
      ...page,
      links: [
        {
          href: SWITCHBOARD_VISITS[3].url,
          label: 'Open sibling analysis thread',
        },
        { href: SWITCHBOARD_PR_110_URL, label: 'Return to PR #110' },
      ],
      controls:
        '<p>Analysis captures PR requirements, route realism notes, and follow-up coding-agent work.</p>',
    });
  }

  if (url.hostname === 'github.com' && url.pathname === '/zyingfei/switchboard') {
    return storyHtml({
      ...page,
      links: [{ href: 'https://github.com/zyingfei/switchboard/pulls', label: 'Pull requests' }],
    });
  }

  if (url.hostname === 'github.com' && url.pathname === '/zyingfei/switchboard/pulls') {
    return storyHtml({
      ...page,
      links: [
        { href: SWITCHBOARD_PR_110_URL, label: 'Stage 4 L5 - full browser sync e2e' },
        {
          href: 'https://github.com/zyingfei/switchboard/pull/109',
          label: 'Stage 4 - L5 full browser sync e2e (Codex pull brief)',
        },
        { href: SWITCHBOARD_VISITS[2].url, label: 'ChatGPT Switchboard project analysis' },
      ],
    });
  }

  if (rawUrl === SWITCHBOARD_PR_110_URL || rawUrl === SWITCHBOARD_PR_110_FILES_URL) {
    return storyHtml({
      ...page,
      links: [
        { href: SWITCHBOARD_PR_110_FILES_URL, label: 'Files changed' },
        { href: SWITCHBOARD_VISITS[2].url, label: 'ChatGPT Switchboard project analysis' },
        { href: SWITCHBOARD_VISITS[4].url, label: 'YouTube ambient context' },
        { href: SWITCHBOARD_VISITS[5].url, label: 'Gemini Switchboard analysis' },
      ],
      controls:
        '<p>Summary: Adds and hardens the Stage 4 L5 composed Playwright e2e and runtime host-permission path.</p>',
    });
  }

  if (
    url.hostname === 'github.com' &&
    url.pathname === '/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py'
  ) {
    return storyHtml({
      ...page,
      links: [
        {
          href: 'https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/README.md',
          label: 'README.md',
        },
        {
          href: 'https://github.com/theori-io/copy-fail-CVE-2026-31431/tree/main',
          label: 'copy-fail-CVE-2026-31431',
        },
      ],
      controls:
        '<textarea id="coding-agent-input" aria-label="Coding agent prompt" placeholder="Paste coding-agent task here"></textarea><textarea id="paste-target" aria-label="Paste target"></textarea>',
    });
  }

  if (url.hostname === 'gemini.google.com') {
    return storyHtml({
      ...page,
      links: [
        {
          href: 'https://www.google.com/search?q=Ranking+and+Training',
          label: 'Ranking and Training',
        },
        { href: SWITCHBOARD_PR_110_URL, label: 'Stage 4 L5 PR' },
      ],
      controls:
        '<button type="button">Tools</button><button type="button">switchboard</button><label>Import code<textarea id="repo-import" aria-label="Import code"></textarea></label><button type="button">Import</button><p>The codebase is currently undergoing a hardening phase, particularly concerning the work graph and connection logic.</p>',
    });
  }

  if (url.hostname === 'www.youtube.com') {
    return storyHtml({
      ...page,
      links: [{ href: SWITCHBOARD_PR_110_URL, label: 'Back to PR review' }],
      controls:
        '<p>Ambient video context remains in the active Switchboard workstream while review continues.</p>',
    });
  }

  return storyHtml(page);
};

const installVisitRoutes = async (runtime: ExtensionRuntime): Promise<void> => {
  await runtime.context.route(/^https?:\/\//u, async (route) => {
    const rawUrl = route.request().url();
    const url = new URL(rawUrl);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fixtureBodyForUrl(rawUrl),
    });
  });
};

const drainTimeline = async (
  runtime: ExtensionRuntime,
  page: Page,
  expectedAtLeast: number,
): Promise<void> => {
  let latest: unknown = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    latest = await runtime.sendRuntimeMessage(page, {
      type: 'sidetrack.timeline.force-drain',
    });
    const result = latest as {
      ok?: boolean;
      drain?: { uploaded?: number; remaining?: number };
    } | null;
    if (result !== null && result.ok === true && (result.drain?.remaining ?? 0) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timeline force drain did not settle after expecting ${String(expectedAtLeast)} visits: ${JSON.stringify(latest)}`,
  );
};

const drainEdgeEvents = async (
  runtime: ExtensionRuntime,
  page: Page,
  expectedAtLeast: number,
  requiredTypes: Readonly<Record<string, number>> = {},
): Promise<void> => {
  let uploaded = 0;
  const uploadedByType: Record<string, number> = {};
  let latest: unknown = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    latest = await runtime.sendRuntimeMessage(page, {
      type: 'sidetrack.edge-events.force-drain',
    });
    const result = latest as {
      ok?: boolean;
      drain?: {
        uploaded?: number;
        remaining?: number;
        uploadedByType?: Record<string, number>;
      };
    } | null;
    uploaded += result?.drain?.uploaded ?? 0;
    for (const [kind, count] of Object.entries(result?.drain?.uploadedByType ?? {})) {
      uploadedByType[kind] = (uploadedByType[kind] ?? 0) + count;
    }
    const hasRequiredTypes = Object.entries(requiredTypes).every(
      ([kind, count]) => (uploadedByType[kind] ?? 0) >= count,
    );
    if (
      result !== null &&
      result.ok === true &&
      uploaded >= expectedAtLeast &&
      hasRequiredTypes &&
      (result.drain?.remaining ?? 0) === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `edge-event force drain uploaded ${String(uploaded)} events (${JSON.stringify(uploadedByType)}), wanted ${String(expectedAtLeast)} and types ${JSON.stringify(requiredTypes)}: ${JSON.stringify(latest)}`,
  );
};

const grantDeeperPageAccess = async (panel: Page): Promise<void> => {
  await panel.getByRole('button', { name: 'Settings' }).click();
  const timelineSection = panel.getByTestId('settings-timeline-section');
  await expect(timelineSection).toBeVisible({ timeout: 10_000 });
  await timelineSection.scrollIntoViewIfNeeded();
  const grantButton = panel.getByTestId('settings-timeline-grant-permission');
  if (await grantButton.isVisible().catch(() => false)) {
    await grantButton.click();
  }
  await expect(panel.getByTestId('settings-timeline-permission-status')).toContainText('granted', {
    timeout: 10_000,
  });
  await panel.locator('button.btn.btn-ghost', { hasText: 'Close' }).click();
};

const setActiveWorkstream = async (
  runtime: ExtensionRuntime,
  panel: Page,
  workstreamId: string,
): Promise<void> => {
  await runtime.seedStorage(panel, {
    'sidetrack.activeWorkstreamId': workstreamId,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
};

const ensureEngagementRuntimeOnPage = async (panel: Page, page: Page): Promise<void> => {
  const targetUrl = normalizeTabLookupUrl(page.url());
  const result = await panel.evaluate(
    async (
      url,
    ): Promise<{ readonly ok: boolean; readonly injected: boolean; readonly error?: string }> => {
      const normalize = (value: string): string => value.replace(/#.*$/u, '').replace(/\/$/u, '');
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => {
        if (typeof candidate.id !== 'number' || typeof candidate.url !== 'string') return false;
        return normalize(candidate.url) === url;
      });
      if (tab?.id === undefined)
        return { ok: false, injected: false, error: `tab not found: ${url}` };
      const isEngagementAck = (value: unknown): boolean =>
        typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;
      const alreadyPresent = await chrome.tabs
        .sendMessage(tab.id, { type: 'sidetrack.engagement.idle', idle: false })
        .then(isEngagementAck)
        .catch(() => false);
      if (alreadyPresent) return { ok: true, injected: false };
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['engagement.js'],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const presentAfterInject = await chrome.tabs
        .sendMessage(tab.id, { type: 'sidetrack.engagement.idle', idle: false })
        .then(isEngagementAck)
        .catch(() => false);
      return {
        ok: presentAfterInject,
        injected: true,
        ...(presentAfterInject ? {} : { error: `engagement runtime did not respond: ${url}` }),
      };
    },
    targetUrl,
  );
  expect(result.ok, result.error ?? `engagement runtime unavailable for ${targetUrl}`).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, result.injected ? 250 : 50));
};

const performCopyPasteBestEffort = async (source: Page, destination: Page): Promise<string> => {
  await source.evaluate(() => {
    window.scrollBy(0, 700);
    const sourceNode = document.querySelector('#copy-source');
    if (sourceNode === null) return;
    const range = document.createRange();
    range.selectNodeContents(sourceNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await source.keyboard
    .press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
    .catch(() => undefined);
  await source
    .evaluate(() => {
      document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
    })
    .catch(() => undefined);
  await source
    .evaluate(async () => {
      await navigator.clipboard
        ?.writeText('copy.fail CVE-2026-31431 Linux crypto subsystem repro notes for VM validation')
        .catch(() => undefined);
    })
    .catch(() => undefined);

  const target = destination.locator('#coding-agent-input, #paste-target').first();
  await target.click().catch(() => undefined);
  await destination.keyboard
    .press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    .catch(() => undefined);
  await destination
    .evaluate(() => {
      const target =
        document.querySelector('#coding-agent-input') ?? document.querySelector('#paste-target');
      if (!(target instanceof HTMLTextAreaElement)) return;
      const data = new DataTransfer();
      data.setData(
        'text/plain',
        'copy.fail CVE-2026-31431 Linux crypto subsystem repro notes for VM validation',
      );
      target.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
      target.value =
        `${target.value} copy.fail CVE-2026-31431 Linux crypto subsystem repro notes for VM validation`.trim();
      target.dispatchEvent(new Event('input', { bubbles: true }));
    })
    .catch(() => undefined);
  const pasted = await destination
    .locator('#coding-agent-input, #paste-target')
    .first()
    .inputValue()
    .catch(() => '');
  expect(pasted).toContain('copy.fail CVE-2026-31431');
  return DISPATCH_SNIPPET;
};

const finalizeEngagementObservation = async (panel: Page, page: Page): Promise<void> => {
  const targetUrl = normalizeTabLookupUrl(page.url());
  const result = await panel.evaluate(
    async (url): Promise<{ readonly ok: boolean; readonly error?: string }> => {
      const normalize = (value: string): string => value.replace(/#.*$/u, '').replace(/\/$/u, '');
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => {
        if (typeof candidate.id !== 'number' || typeof candidate.url !== 'string') return false;
        return normalize(candidate.url) === url;
      });
      if (tab?.id === undefined) return { ok: false, error: `tab not found: ${url}` };
      return await chrome.tabs
        .sendMessage(tab.id, { type: 'sidetrack.engagement.force-finalize' })
        .then(() => ({ ok: true }))
        .catch((error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    },
    targetUrl,
  );
  expect(result.ok, result.error ?? `engagement finalize failed for ${targetUrl}`).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 250));
};

const dwellAndScroll = async (page: Page, dwellMs = 6_000): Promise<void> => {
  const started = Date.now();
  await page.bringToFront();
  for (let index = 0; index < 4; index += 1) {
    await page
      .evaluate(
        (step) => window.scrollTo(0, Math.round((document.body.scrollHeight * step) / 4)),
        index + 1,
      )
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const remaining = dwellMs - (Date.now() - started);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
};

const observeCurrentPageInWorkstream = async (
  runtime: ExtensionRuntime,
  panel: Page,
  page: Page,
  workstreamId: string,
  dwellMs = 6_000,
): Promise<void> => {
  await setActiveWorkstream(runtime, panel, workstreamId);
  await ensureEngagementRuntimeOnPage(panel, page);
  await dwellAndScroll(page, dwellMs);
  await finalizeEngagementObservation(panel, page);
};

const waitForStoryUrl = async (page: Page, expectedUrl: string): Promise<void> => {
  await page
    .waitForURL(
      (url) => normalizeTabLookupUrl(url.toString()) === normalizeTabLookupUrl(expectedUrl),
      { waitUntil: 'domcontentloaded', timeout: 15_000 },
    )
    .catch(() => undefined);
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
};

const openStoryRoot = async (
  runtime: ExtensionRuntime,
  panel: Page,
  page: Page,
  url: string,
  workstreamId: string,
  dwellMs = 6_000,
): Promise<void> => {
  await setActiveWorkstream(runtime, panel, workstreamId);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await observeCurrentPageInWorkstream(runtime, panel, page, workstreamId, dwellMs);
};

const clickStoryLink = async (
  runtime: ExtensionRuntime,
  panel: Page,
  page: Page,
  input: {
    readonly label: string | RegExp;
    readonly expectedUrl: string;
    readonly workstreamId: string;
    readonly dwellMs?: number;
  },
): Promise<void> => {
  await setActiveWorkstream(runtime, panel, input.workstreamId);
  await page.getByRole('link', { name: input.label }).click();
  await waitForStoryUrl(page, input.expectedUrl);
  await observeCurrentPageInWorkstream(
    runtime,
    panel,
    page,
    input.workstreamId,
    input.dwellMs ?? 6_000,
  );
};

const driveBrowserAVisits = async (
  runtime: ExtensionRuntime,
  panel: Page,
  input: {
    readonly securityWorkstreamId: string;
    readonly switchboardWorkstreamId: string;
  },
): Promise<{ readonly dispatchSnippet: string }> => {
  const securityTab = await runtime.context.newPage();
  const googleTab = await runtime.context.newPage();
  const sourceCopyFailTab = await runtime.context.newPage();
  const copyFailTab = await runtime.context.newPage();
  const codingAgentTab = await runtime.context.newPage();
  const switchboardTab = await runtime.context.newPage();
  const chatgptReviewTab = await runtime.context.newPage();
  const youtubeTab = await runtime.context.newPage();
  const geminiTab = await runtime.context.newPage();

  // Security flow, shaped after the manual recording: start on HN,
  // click the story title into copy.fail, then follow the write-up.
  await openStoryRoot(
    runtime,
    panel,
    securityTab,
    SECURITY_VISITS[0].url,
    input.securityWorkstreamId,
  );
  await clickStoryLink(runtime, panel, securityTab, {
    label: 'Copy Fail',
    expectedUrl: SECURITY_VISITS[4].url,
    workstreamId: input.securityWorkstreamId,
  });
  await clickStoryLink(runtime, panel, securityTab, {
    label: 'Read the write-up',
    expectedUrl: SECURITY_VISITS[1].url,
    workstreamId: input.securityWorkstreamId,
  });

  // The recorded search was copy/paste driven; the deterministic test
  // keeps it keyboard-driven but reaches the same real-shaped query URL
  // and follows a result link to the ChatGPT analysis thread.
  await openStoryRoot(
    runtime,
    panel,
    googleTab,
    GOOGLE_HOME_URL,
    input.securityWorkstreamId,
    1_500,
  );
  await setActiveWorkstream(runtime, panel, input.securityWorkstreamId);
  await googleTab.getByLabel('Search').fill('Linux crypto subsystem');
  await googleTab.keyboard.press('Enter');
  await waitForStoryUrl(googleTab, SECURITY_VISITS[2].url);
  await observeCurrentPageInWorkstream(
    runtime,
    panel,
    googleTab,
    input.securityWorkstreamId,
    6_000,
  );
  await clickStoryLink(runtime, panel, googleTab, {
    label: 'ChatGPT copy-fail analysis',
    expectedUrl: SECURITY_VISITS[3].url,
    workstreamId: input.securityWorkstreamId,
  });

  // Dispatch direction: keep a source copy.fail page open, then click
  // copy.fail -> exploit -> GitHub and paste the snippet into the
  // coding-agent prompt surface on the GitHub page.
  await openStoryRoot(
    runtime,
    panel,
    sourceCopyFailTab,
    SECURITY_VISITS[4].url,
    input.securityWorkstreamId,
  );
  await openStoryRoot(
    runtime,
    panel,
    copyFailTab,
    SECURITY_VISITS[4].url,
    input.securityWorkstreamId,
  );
  await setActiveWorkstream(runtime, panel, input.securityWorkstreamId);
  await copyFailTab.getByRole('link', { name: 'Get the exploit' }).click();
  await waitForStoryUrl(copyFailTab, 'https://copy.fail/#exploit');
  await copyFailTab.getByRole('link', { name: 'Download (GitHub)' }).click();
  await waitForStoryUrl(copyFailTab, SECURITY_VISITS[5].url);
  await observeCurrentPageInWorkstream(
    runtime,
    panel,
    copyFailTab,
    input.securityWorkstreamId,
    6_000,
  );
  const dispatchSnippet = await performCopyPasteBestEffort(sourceCopyFailTab, copyFailTab);
  await finalizeEngagementObservation(panel, sourceCopyFailTab);
  await finalizeEngagementObservation(panel, copyFailTab);

  // Switchboard flow: explicit active-workstream toggle remains the
  // implemented attribution hook. The route through GitHub/PRs/AI
  // pages is click-shaped from the recorded manual pass.
  await openStoryRoot(
    runtime,
    panel,
    switchboardTab,
    SWITCHBOARD_VISITS[0].url,
    input.switchboardWorkstreamId,
  );
  await clickStoryLink(runtime, panel, switchboardTab, {
    label: 'Pull requests',
    expectedUrl: SWITCHBOARD_VISITS[1].url,
    workstreamId: input.switchboardWorkstreamId,
  });
  await clickStoryLink(runtime, panel, switchboardTab, {
    label: 'Stage 4 L5 - full browser sync e2e',
    expectedUrl: SWITCHBOARD_PR_110_URL,
    workstreamId: input.switchboardWorkstreamId,
    dwellMs: 2_000,
  });
  await clickStoryLink(runtime, panel, switchboardTab, {
    label: 'Files changed',
    expectedUrl: SWITCHBOARD_PR_110_FILES_URL,
    workstreamId: input.switchboardWorkstreamId,
    dwellMs: 2_000,
  });

  await openStoryRoot(
    runtime,
    panel,
    chatgptReviewTab,
    SWITCHBOARD_PR_110_URL,
    input.switchboardWorkstreamId,
    1_500,
  );
  await clickStoryLink(runtime, panel, chatgptReviewTab, {
    label: 'ChatGPT Switchboard project analysis',
    expectedUrl: SWITCHBOARD_VISITS[2].url,
    workstreamId: input.switchboardWorkstreamId,
  });
  await clickStoryLink(runtime, panel, chatgptReviewTab, {
    label: 'Open sibling analysis thread',
    expectedUrl: SWITCHBOARD_VISITS[3].url,
    workstreamId: input.switchboardWorkstreamId,
  });

  await openStoryRoot(
    runtime,
    panel,
    youtubeTab,
    SWITCHBOARD_PR_110_URL,
    input.switchboardWorkstreamId,
    1_500,
  );
  await clickStoryLink(runtime, panel, youtubeTab, {
    label: 'YouTube ambient context',
    expectedUrl: SWITCHBOARD_VISITS[4].url,
    workstreamId: input.switchboardWorkstreamId,
  });

  await openStoryRoot(
    runtime,
    panel,
    geminiTab,
    SWITCHBOARD_PR_110_URL,
    input.switchboardWorkstreamId,
    1_500,
  );
  await clickStoryLink(runtime, panel, geminiTab, {
    label: 'Gemini Switchboard analysis',
    expectedUrl: SWITCHBOARD_VISITS[5].url,
    workstreamId: input.switchboardWorkstreamId,
    dwellMs: 1_000,
  });
  await geminiTab.getByRole('button', { name: 'Tools' }).click();
  await geminiTab.getByRole('button', { name: 'switchboard' }).click();
  await geminiTab.getByLabel('Import code').fill('https://github.com/zyingfei/switchboard');
  await geminiTab.getByRole('button', { name: 'Import' }).click();
  await observeCurrentPageInWorkstream(
    runtime,
    panel,
    geminiTab,
    input.switchboardWorkstreamId,
    6_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { dispatchSnippet };
};

const collectorManifest = (): string => `id = "${CODEX_COLLECTOR_ID}"
name = "Sidetrack Codex CLI"
version = "0.1.0"
manifest_schema = 1

[compatibility]
requires-companion = ">=1.0.0 <2.0.0"
requires-vault = 1

[[emits]]
event_type = "session_started"
payload_version = 1
stability = "alpha"

[[emits]]
event_type = "session_turn"
payload_version = 1
stability = "alpha"

[io]
rotation = "daily"

[capabilities]
reads-paths = []
reads-env = []
reads-network = false
default-enabled = true

[process]
managed-by = "user"
`;

const collectorLine = (input: {
  readonly eventType: 'session_started' | 'session_turn';
  readonly emittedAt: string;
  readonly runId: string;
  readonly sourceRecordId: string;
  readonly payload: Record<string, unknown>;
  readonly dimensions?: Record<string, unknown>;
}): string =>
  JSON.stringify({
    collector_id: CODEX_COLLECTOR_ID,
    event_type: input.eventType,
    payload_version: 1,
    emitted_at: input.emittedAt,
    collector_version: '0.1.0',
    collector_run_id: input.runId,
    source_record_id: input.sourceRecordId,
    payload: input.payload,
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
  });

const waitForCollectorLoaded = async (comp: TestCompanion): Promise<void> => {
  await waitForCondition(async () => {
    const env = (await apiGet(comp, '/v1/collectors')) as CollectorsEnvelope;
    return env.collectors.some(
      (collector) => collector.collector_id === CODEX_COLLECTOR_ID && collector.status === 'loaded',
    );
  }, 'Codex collector manifest was not loaded');
};

const waitForCollectorPromotion = async (comp: TestCompanion): Promise<void> => {
  await waitForCondition(async () => {
    const env = (await apiGet(comp, '/v1/collectors')) as CollectorsEnvelope;
    return env.collectors.some(
      (collector) =>
        collector.collector_id === CODEX_COLLECTOR_ID &&
        collector.status === 'loaded' &&
        collector.last_promoted_at !== null &&
        collector.quarantine_count === 0,
    );
  }, 'Codex collector inbox lines were not promoted');
};

const writeCodexCollectorFixture = async (
  vaultPath: string,
  comp: TestCompanion,
  input: {
    readonly dispatchId: string;
    readonly codingSessionId: string;
  },
): Promise<void> => {
  const manifestDir = join(vaultPath, '_BAC', 'collectors', CODEX_COLLECTOR_ID);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, 'collector.toml'), collectorManifest(), 'utf8');
  await waitForCollectorLoaded(comp);

  const now = Date.now();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const runId = `run-${randomUUID()}`;
  const sessions = [input.codingSessionId, 'codex-l5-switchboard-review'] as const;
  const dimensions = {
    dispatchId: input.dispatchId,
    codingSessionId: input.codingSessionId,
  };
  const lines = [
    collectorLine({
      eventType: 'session_started',
      emittedAt: iso(-40_000),
      runId,
      sourceRecordId: sessions[0],
      payload: {
        session_id: sessions[0],
        started_at: iso(-40_000),
        cwd: '/repo/browser-ai-companion',
        model: 'gpt-5-codex',
      },
      ...(sessions[0] === input.codingSessionId ? { dimensions } : {}),
    }),
    collectorLine({
      eventType: 'session_started',
      emittedAt: iso(-35_000),
      runId,
      sourceRecordId: sessions[1],
      payload: {
        session_id: sessions[1],
        started_at: iso(-35_000),
        cwd: '/repo/browser-ai-companion',
        model: 'gpt-5-codex',
      },
    }),
    ...[0, 1, 2, 3].map((turn) => {
      const sessionId = sessions[turn % sessions.length];
      return collectorLine({
        eventType: 'session_turn',
        emittedAt: iso(-30_000 + turn * 2_000),
        runId,
        sourceRecordId: `${sessionId}:${String(turn)}`,
        payload: {
          session_id: sessionId,
          turn_index: turn,
          started_at: iso(-30_000 + turn * 2_000),
          completed_at: iso(-29_000 + turn * 2_000),
          model: 'gpt-5-codex',
          prompt_text:
            sessionId === input.codingSessionId
              ? `Use copy_fail_exp.py in a VM for dispatch ${input.dispatchId}`
              : `Review Switchboard PR state for L5 full browser sync step ${String(turn)}`,
          response_text:
            sessionId === input.codingSessionId
              ? `Started VM validation for dispatch ${input.dispatchId}`
              : `Completed Switchboard PR review step ${String(turn)}`,
          tool_call_count: 2,
          exec_command_count: 1,
        },
        ...(sessionId === input.codingSessionId ? { dimensions } : {}),
      });
    }),
  ];

  const dateStamp = new Date().toISOString().slice(0, 10);
  const inboxDir = join(vaultPath, '_BAC', 'inbox', CODEX_COLLECTOR_ID);
  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, `${dateStamp}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  await waitForCollectorPromotion(comp);
};

const readJsonlLogEvents = async (
  vaultPath: string,
): Promise<readonly Record<string, unknown>[]> => {
  const root = join(vaultPath, '_BAC', 'log');
  const out: Record<string, unknown>[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries: readonly {
      readonly name: string;
      readonly isDirectory: () => boolean;
      readonly isFile: () => boolean;
    }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const raw = await readFile(fullPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) out.push(parsed);
      }
    }
  };

  await visit(root);
  return out;
};

const hasCodingTurn = async (vaultPath: string): Promise<boolean> => {
  const events = await readJsonlLogEvents(vaultPath);
  return events.some((event) => {
    if (event['type'] === 'coding.session.turn.observed') return true;
    const payload = event['payload'];
    return isRecord(payload) && payload['type'] === 'coding.session.turn.observed';
  });
};

const hasCodingTurnForSession = async (
  vaultPath: string,
  input: {
    readonly codingSessionId: string;
    readonly dispatchId: string;
  },
): Promise<boolean> => {
  const events = await readJsonlLogEvents(vaultPath);
  return events.some((event) => {
    const payload = event['payload'];
    if (!isRecord(payload) || payload['type'] !== 'coding.session.turn.observed') {
      return false;
    }
    const dimensions = payload['dimensions'];
    return (
      payload['sessionId'] === input.codingSessionId &&
      isRecord(dimensions) &&
      dimensions['dispatchId'] === input.dispatchId &&
      dimensions['codingSessionId'] === input.codingSessionId
    );
  });
};

const createCodingDispatch = async (
  comp: TestCompanion,
  input: {
    readonly workstreamId: string;
    readonly codingSessionId: string;
    readonly snippet: string;
  },
): Promise<string> => {
  const createdAt = new Date().toISOString();
  const response = (await apiPost(comp, '/v1/dispatches', {
    kind: 'coding',
    target: { provider: 'codex', mode: 'paste' },
    workstreamId: input.workstreamId,
    title: 'Use copy_fail_exp.py in VM',
    body:
      `${input.snippet}\n\n` +
      'Use https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py ' +
      'to validate the copy.fail Linux crypto subsystem issue in an isolated VM.',
    createdAt,
    mcpRequest: {
      codingSessionId: input.codingSessionId,
      approval: 'auto-approved',
      requestedAt: createdAt,
    },
  })) as { readonly data?: { readonly bac_id?: unknown } };
  const dispatchId = response.data?.bac_id;
  if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
    throw new Error(`Dispatch response did not include bac_id: ${JSON.stringify(response)}`);
  }
  return dispatchId;
};

test.describe('connections - full browser sync user story (Stage 1 + 2/3 + 4 composed)', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(HOLD_OPEN_ON_CONNECTIONS ? 0 : 600_000);

  let relay: TestRelay | null = null;
  let companionA: TestCompanion | null = null;
  let companionB: TestCompanion | null = null;
  let runtimeA: ExtensionRuntime | null = null;
  let runtimeB: ExtensionRuntime | null = null;
  let llmMockA: LlmNetworkMock | null = null;
  let llmMockB: LlmNetworkMock | null = null;

  test.afterAll(async () => {
    if (HOLD_OPEN_ON_CONNECTIONS) return;
    if (runtimeA !== null) await runtimeA.close();
    if (runtimeB !== null) await runtimeB.close();
    if (companionA !== null) await companionA.close();
    if (companionB !== null) await companionB.close();
    if (relay !== null) await relay.close();
    runtimeA = null;
    runtimeB = null;
    companionA = null;
    companionB = null;
    relay = null;
  });

  test('syncs A browser activity and collector events to B with feedback/ranker surfaces', async () => {
    relay = await startTestRelay({});
    const secret = generateRendezvousSecret().toString('base64url');
    companionA = await startTestCompanion({
      syncRelay: relay.url,
      syncRendezvousSecret: secret,
    });
    companionB = await startTestCompanion({
      syncRelay: relay.url,
      syncRendezvousSecret: secret,
    });
    runtimeA = await launchExtensionRuntime({
      forceLocalProfile: true,
      extraHostPermissions: REAL_STORY_HOST_PERMISSIONS,
    });
    runtimeB = await launchExtensionRuntime({
      forceLocalProfile: true,
      extraHostPermissions: REAL_STORY_HOST_PERMISSIONS,
    });
    llmMockA = await installLlmNetworkMock(runtimeA.context);
    llmMockB = await installLlmNetworkMock(runtimeB.context);
    await installVisitRoutes(runtimeA);
    await installVisitRoutes(runtimeB);

    await openPrivacyGate(companionA, 'engagement');
    const panelA = await openConnectionsPanel(runtimeA, companionA);
    const panelB = await openConnectionsPanel(runtimeB, companionB);

    // Let Browser B's vault-change SSE client settle before Browser A
    // creates workstreams. The assertion below still proves the
    // production sync path because Browser B is not storage-seeded.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const wsSecurityId = await createWorkstreamThroughExtension(runtimeA, panelA, {
      title: 'Copy-fail Linux security research',
    });
    const wsSwitchboardId = await createWorkstreamThroughExtension(runtimeA, panelA, {
      title: 'Switchboard PR review',
    });
    const expectedWorkstreams = [
      { id: wsSecurityId, title: 'Copy-fail Linux security research' },
      { id: wsSwitchboardId, title: 'Switchboard PR review' },
    ] as const;
    const codingSessionId = `cs_copyfail_vm_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

    await expectWorkstreamSelectorOptions(panelA, expectedWorkstreams);
    await waitForCondition(
      async () => await extensionHasWorkstreams(runtimeB!, panelB, [wsSecurityId, wsSwitchboardId]),
      'Browser B extension state did not mirror workstreams created through Browser A extension',
      120_000,
    );
    await expectWorkstreamSelectorOptions(panelB, expectedWorkstreams);

    await runtimeA.seedStorage(panelA, {
      'sidetrack.timeline.enabled': true,
      'sidetrack.activeWorkstreamId': wsSecurityId,
    });
    const reinit = await runtimeA.sendRuntimeMessage(panelA, {
      type: 'sidetrack.timeline.reinit',
    });
    expect((reinit as { ok?: boolean } | null)?.ok).toBe(true);
    await grantDeeperPageAccess(panelA);
    const gateChanged = await runtimeA.sendRuntimeMessage(panelA, {
      type: 'sidetrack.privacy.gateChanged',
    });
    expect((gateChanged as { ok?: boolean } | null)?.ok).toBe(true);

    const browserAFlow = await driveBrowserAVisits(runtimeA, panelA, {
      securityWorkstreamId: wsSecurityId,
      switchboardWorkstreamId: wsSwitchboardId,
    });
    const drainSender = await runtimeA.context.newPage();
    await drainSender.goto(`chrome-extension://${runtimeA.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await drainTimeline(runtimeA, drainSender, ALL_URLS.length);
    await drainEdgeEvents(runtimeA, drainSender, ALL_URLS.length, {
      'engagement.session.aggregated': 1,
    });
    await drainSender.close();

    const dispatchId = await createCodingDispatch(companionA, {
      workstreamId: wsSecurityId,
      codingSessionId,
      snippet: browserAFlow.dispatchSnippet,
    });
    await writeCodexCollectorFixture(companionA.vaultPath, companionA, {
      dispatchId,
      codingSessionId,
    });
    const bootstrapFeedback = await postBootstrapFeedbackLabels(companionA);

    const expectedVisitIds = ALL_URLS.map(graphVisitNodeId);
    await waitForConnections(
      companionA,
      (env) => {
        const ids = new Set(env.data.snapshot.nodes.map((node) => node.id));
        return expectedVisitIds.every((id) => ids.has(id));
      },
      'Browser A visits did not materialize in companion A',
    );

    const syncedEnv = await waitForConnections(
      companionB,
      (env) => {
        const ids = new Set(env.data.snapshot.nodes.map((node) => node.id));
        return (
          ids.has(`workstream:${wsSecurityId}`) &&
          ids.has(`workstream:${wsSwitchboardId}`) &&
          expectedVisitIds.every((id) => ids.has(id)) &&
          hasStoryWorkstreamAttribution(env, {
            securityWorkstreamId: wsSecurityId,
            switchboardWorkstreamId: wsSwitchboardId,
          })
        );
      },
      'Browser B did not receive Browser A visits with expected workstream attribution through the relay',
      // 240 s instead of 120 s. The story drives 13 visits across
      // two workstreams; each goes through observer → drain → relay
      // → companion-B materializer. With the workstream-attribution
      // restoration (2026-05) every visit also emits a
      // `visit_in_workstream` edge through the projection — more
      // work per replay tick. 120 s was the tight floor; 240 s
      // gives the second batch room to land before the predicate
      // gives up.
      240_000,
    );

    for (const { workstreamId, visits } of [
      { workstreamId: wsSecurityId, visits: SECURITY_VISITS },
      { workstreamId: wsSwitchboardId, visits: SWITCHBOARD_VISITS },
    ] as const) {
      for (const visit of visits) {
        const nodeId = graphVisitNodeId(visit.url);
        const node = syncedEnv.data.snapshot.nodes.find((candidate) => candidate.id === nodeId);
        expect(node, `${nodeId} in ${visit.flow}`).toBeDefined();
        expect(node?.metadata?.workstreamId, `${visit.url} in ${visit.flow}`).toBe(workstreamId);
        expect(
          syncedEnv.data.snapshot.edges.some(
            (edge) =>
              edge.kind === 'visit_in_workstream' &&
              edge.fromNodeId === nodeId &&
              edge.toNodeId === `workstream:${workstreamId}`,
          ),
        ).toBe(true);
      }
    }

    await waitForCondition(
      async () =>
        (await hasCodingTurn(companionB!.vaultPath)) &&
        (await hasCodingTurnForSession(companionB!.vaultPath, {
          codingSessionId,
          dispatchId,
        })),
      'Browser B vault log did not receive collector-promoted coding turns tied to the dispatch session',
      120_000,
    );

    const dispatchEnv = await waitForConnections(
      companionB,
      (env) =>
        env.data.snapshot.edges.some(
          (edge) =>
            edge.kind === 'dispatch_in_workstream' &&
            edge.fromNodeId === `dispatch:${dispatchId}` &&
            edge.toNodeId === `workstream:${wsSecurityId}`,
        ) &&
        env.data.snapshot.edges.some(
          (edge) =>
            edge.kind === 'dispatch_requested_coding_session' &&
            edge.fromNodeId === `dispatch:${dispatchId}` &&
            edge.toNodeId === `coding-session:${codingSessionId}`,
        ),
      'Browser B did not receive dispatch forward edges through the relay',
      120_000,
    );
    expect(
      dispatchEnv.data.snapshot.edges.some(
        (edge) =>
          edge.kind === 'dispatch_in_workstream' &&
          edge.fromNodeId === `dispatch:${dispatchId}` &&
          edge.toNodeId === `workstream:${wsSecurityId}`,
      ),
    ).toBe(true);
    expect(
      dispatchEnv.data.snapshot.edges.some(
        (edge) =>
          edge.kind === 'dispatch_requested_coding_session' &&
          edge.fromNodeId === `dispatch:${dispatchId}` &&
          edge.toNodeId === `coding-session:${codingSessionId}`,
      ),
    ).toBe(true);

    await runtimeB.seedStorage(panelB, {
      'sidetrack.timeline.enabled': true,
      'sidetrack.activeWorkstreamId': wsSecurityId,
    });
    const reinitB = await runtimeB.sendRuntimeMessage(panelB, {
      type: 'sidetrack.timeline.reinit',
    });
    expect((reinitB as { ok?: boolean } | null)?.ok).toBe(true);
    const sharedVisit = await runtimeB.context.newPage();
    await sharedVisit
      .goto(SECURITY_VISITS[0].url, { waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await sharedVisit.close();
    const drainSenderB = await runtimeB.context.newPage();
    await drainSenderB.goto(`chrome-extension://${runtimeB.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await drainTimeline(runtimeB, drainSenderB, 1);
    await drainEdgeEvents(runtimeB, drainSenderB, 1);
    await drainSenderB.close();

    const navigationEnv = await waitForConnections(
      companionB,
      (env) =>
        env.data.snapshot.edges.some((edge) => edge.kind === 'visit_observed_on_replica') &&
        env.data.snapshot.edges.some((edge) => edge.kind === 'previous_visit_in_tab_session'),
      'Browser B did not materialize cross-replica navigation edges',
      120_000,
    );
    expect(
      navigationEnv.data.snapshot.edges.some((edge) => edge.kind === 'visit_observed_on_replica'),
    ).toBe(true);
    expect(
      navigationEnv.data.snapshot.edges.some(
        (edge) => edge.kind === 'previous_visit_in_tab_session',
      ),
    ).toBe(true);

    await setConnectionsAnchor(panelB, `workstream:${wsSecurityId}`);
    for (const visit of SECURITY_VISITS) {
      await expect(panelB.getByTestId(`node-${graphVisitNodeId(visit.url)}`)).toBeVisible({
        timeout: 20_000,
      });
    }
    await setConnectionsAnchor(panelB, `workstream:${wsSwitchboardId}`, '3');
    for (const visit of SWITCHBOARD_VISITS) {
      await expect(panelB.getByTestId(`node-${graphVisitNodeId(visit.url)}`)).toBeVisible({
        timeout: 20_000,
      });
    }

    await waitForCondition(async () => {
      const projection = (await apiGet(
        companionB!,
        '/v1/feedback/projection',
      )) as FeedbackProjectionEnvelope;
      return (
        projection.data.positiveLabels.some(
          (label) =>
            label.fromId === bootstrapFeedback.positive.fromId &&
            label.toId === bootstrapFeedback.positive.toId,
        ) &&
        projection.data.negativeLabels.some(
          (label) =>
            label.fromId === bootstrapFeedback.negative.fromId &&
            label.toId === bootstrapFeedback.negative.toId,
        )
      );
    }, 'Browser B did not receive Browser A feedback labels through the relay');
    const initialProjection = (await apiGet(
      companionB,
      '/v1/feedback/projection',
    )) as FeedbackProjectionEnvelope;
    expect(
      initialProjection.data.positiveLabels.some(
        (label) =>
          label.fromId === bootstrapFeedback.positive.fromId &&
          label.toId === bootstrapFeedback.positive.toId,
      ),
    ).toBe(true);
    expect(
      initialProjection.data.negativeLabels.some(
        (label) =>
          label.fromId === bootstrapFeedback.negative.fromId &&
          label.toId === bootstrapFeedback.negative.toId,
      ),
    ).toBe(true);

    const retrained = (await apiPost(companionB, '/v1/connections/ranker/retrain', {
      force: true,
      threshold: 1,
      numRound: 8,
      randomNegativeCandidatesPerPositive: 1,
    })) as RetrainEnvelope;
    expect(retrained.data.status).toBe('trained');
    if (retrained.data.status !== 'trained') {
      throw new Error(`ranker did not train: ${JSON.stringify(retrained.data)}`);
    }
    const rankerRevisionId = retrained.data.revisionId;

    const rankedEnv = await waitForConnections(
      companionB,
      (env) =>
        env.data.snapshot.edges.some(
          (edge) =>
            edge.kind === 'closest_visit' &&
            edge.producedBy?.source === 'ranker' &&
            typeof edge.producedBy.revisionId === 'string' &&
            topContributionCount(edge) > 0,
        ),
      'Browser B did not materialize ranker closest_visit edges',
      120_000,
    );
    const rankerEdge = rankedEnv.data.snapshot.edges.find(
      (edge) =>
        edge.kind === 'closest_visit' &&
        edge.producedBy?.source === 'ranker' &&
        edge.producedBy.revisionId === rankerRevisionId &&
        topContributionCount(edge) > 0,
    );
    expect(rankerEdge, 'ranker closest_visit edge').toBeDefined();
    if (rankerEdge === undefined) throw new Error('Missing ranker edge');

    await setConnectionsAnchor(panelB, `workstream:${wsSecurityId}`, '4');
    await clickVisibleEdge(panelB, rankerEdge);
    await expect(panelB.getByTestId('edge-provenance')).toBeVisible({ timeout: 10_000 });
    await expect(panelB.getByTestId('producer-pin-ranker')).toBeVisible();
    await panelB.getByTestId('producer-pin-ranker-pin').click();
    const pinnedRevision = await panelB.evaluate(async () => {
      const got = await chrome.storage.local.get('sidetrack.producerPin.ranker');
      const value = got['sidetrack.producerPin.ranker'];
      return typeof value === 'string' ? value : null;
    });
    expect(pinnedRevision).toBe(rankerRevisionId);

    await panelB.getByTestId('edge-provenance').getByTestId('feedback-confirm').click();
    await expect(panelB.getByTestId('edge-provenance').getByTestId('feedback-saved')).toBeVisible();
    const rankerEdges = feedbackCapableEdges(rankedEnv).filter(
      (edge) => edge.kind === 'closest_visit',
    );
    const uiRejectEdge =
      rankerEdges.find((edge) => !edgeConnects(edge, rankerEdge.fromNodeId, rankerEdge.toNodeId)) ??
      rankerEdge;
    await setConnectionsAnchor(panelB, `workstream:${wsSecurityId}`, '4');
    await clickVisibleEdge(panelB, uiRejectEdge);
    await panelB.getByTestId('edge-provenance').getByTestId('feedback-reject').click();
    await expect(panelB.getByTestId('edge-provenance').getByTestId('feedback-saved')).toBeVisible();

    const uiProjection = (await apiGet(
      companionB,
      '/v1/feedback/projection',
    )) as FeedbackProjectionEnvelope;
    expect(
      uiProjection.data.positiveLabels.some(
        (label) => label.fromId === rankerEdge.fromNodeId && label.toId === rankerEdge.toNodeId,
      ),
    ).toBe(true);
    expect(
      uiProjection.data.negativeLabels.some(
        (label) => label.fromId === uiRejectEdge.fromNodeId && label.toId === uiRejectEdge.toNodeId,
      ),
    ).toBe(true);

    await panelB.getByTestId('connections-mode-flow').click();
    await expect(panelB.getByTestId('flow-path-view')).toBeVisible();
    await panelB.getByTestId(`flow-visit-${rankerEdge.fromNodeId}`).click();
    await expect(panelB.getByTestId('why-related-panel')).toBeVisible();
    await expect(panelB.getByTestId('why-related-panel')).toContainText(/Ranker score/u);

    const surfacedEnv = await waitForConnections(
      companionB,
      (env) =>
        env.data.snapshot.nodes.some((node) => node.kind === 'topic') &&
        env.data.snapshot.nodes.some(hasEngagementClass),
      'Browser B did not surface topic nodes and engagement classes',
      120_000,
    );
    const topicNodes = surfacedEnv.data.snapshot.nodes.filter((node) => node.kind === 'topic');
    expect(topicNodes.length).toBeGreaterThan(0);
    const engagementClasses = surfacedEnv.data.snapshot.nodes
      .filter((node) => node.kind === 'timeline-visit')
      .map((node) => node.metadata?.engagement)
      .filter((value) => isRecord(value) && typeof value['class'] === 'string');
    expect(engagementClasses.length).toBeGreaterThan(0);
    const navigationEdges = navigationEnv.data.snapshot.edges.filter(
      (edge) =>
        edge.kind === 'visit_observed_on_replica' || edge.kind === 'previous_visit_in_tab_session',
    );
    expect(navigationEdges.some((edge) => edge.kind === 'visit_observed_on_replica')).toBe(true);
    expect(navigationEdges.some((edge) => edge.kind === 'previous_visit_in_tab_session')).toBe(
      true,
    );

    llmMockA.assertNoLlmCalls();
    llmMockB.assertNoLlmCalls();
    await holdOpenOnConnectionsView({
      panel: panelB,
      runtime: runtimeB,
      companion: companionB,
      securityWorkstreamId: wsSecurityId,
      switchboardWorkstreamId: wsSwitchboardId,
    });
  });
});
