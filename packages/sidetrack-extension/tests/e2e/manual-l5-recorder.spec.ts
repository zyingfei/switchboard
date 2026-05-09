// Manual L5 realism recorder - NOT a CI test.
//
// Run with:
//   SIDETRACK_USER_DATA_DIR=~/.sidetrack-test-profile \
//     npm run e2e:manual-l5-recorder
//
// The browser stays open until stdin advances the two prompts:
//   1. first Enter: stop recording, drain Sidetrack, write artifacts
//   2. second Enter: close browsers and companion processes

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { ManualRecorder } from './helpers/manualRecorder';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

type FlowKey = 'security' | 'switchboard';

interface VisitLink {
  readonly flow: FlowKey;
  readonly title: string;
  readonly url: string;
  readonly note: string;
}

interface ConnectionsEnvelope {
  readonly data?: {
    readonly snapshot?: {
      readonly nodes?: readonly {
        readonly id?: string;
        readonly kind?: string;
        readonly label?: string;
      }[];
      readonly edges?: readonly {
        readonly id?: string;
        readonly kind?: string;
        readonly fromNodeId?: string;
        readonly toNodeId?: string;
      }[];
    };
  };
}

const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const CODEX_COLLECTOR_ID = 'sidetrack.codex-cli';
const RECORDER_HOST_PERMISSIONS = ['https://*/*', 'http://*/*'] as const;
const PROFILE_ENV = 'SIDETRACK_USER_DATA_DIR';
const DEFAULT_PROFILE = '~/.sidetrack-test-profile';

const VISIT_LINKS: readonly VisitLink[] = [
  {
    flow: 'security',
    title: 'HN: copy-fail discussion',
    url: 'https://news.ycombinator.com/item?id=47952181',
    note: 'Start here, then use page links where possible.',
  },
  {
    flow: 'security',
    title: 'xint.io: copy-fail across Linux distributions',
    url: 'https://xint.io/blog/copy-fail-linux-distributions',
    note: 'Read through, then continue to copy.fail and the GitHub exploit link.',
  },
  {
    flow: 'security',
    title: 'Google: Linux crypto subsystem',
    url: 'https://www.google.com/search?q=Linux+crypto+subsystem',
    note: 'Search context for the Linux crypto subsystem.',
  },
  {
    flow: 'security',
    title: 'ChatGPT: copy-fail analysis thread',
    url: 'https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd',
    note: 'Logged-in profile may be needed.',
  },
  {
    flow: 'security',
    title: 'copy.fail landing page',
    url: 'https://copy.fail/',
    note: 'Copy a useful snippet from this page.',
  },
  {
    flow: 'security',
    title: 'GitHub: copy_fail_exp.py',
    url: 'https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py',
    note: 'Paste the copy.fail snippet into a coding-agent prompt/input if available.',
  },
  {
    flow: 'switchboard',
    title: 'GitHub: zyingfei/switchboard',
    url: 'https://github.com/zyingfei/switchboard',
    note: 'Start Switchboard PR review flow here.',
  },
  {
    flow: 'switchboard',
    title: 'GitHub: Switchboard PRs',
    url: 'https://github.com/zyingfei/switchboard/pulls',
    note: 'Review open PR list.',
  },
  {
    flow: 'switchboard',
    title: 'ChatGPT: Switchboard project thread',
    url: 'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae-switchboard/c/69fd259a-83b0-8326-a4d9-c4c1b76a5986',
    note: 'Logged-in profile may be needed.',
  },
  {
    flow: 'switchboard',
    title: 'ChatGPT: sibling analysis thread',
    url: 'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69fcb926-3a98-8328-bbe4-baee4da7fbef',
    note: 'Parallel ChatGPT analysis.',
  },
  {
    flow: 'switchboard',
    title: 'YouTube: ambient context',
    url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
    note: 'Keep Switchboard workstream active before opening this ambient visit.',
  },
  {
    flow: 'switchboard',
    title: 'Gemini: Switchboard analysis',
    url: 'https://gemini.google.com/app/7a97310e824ccad4?hl=en-US',
    note: 'Logged-in profile may be needed.',
  },
] as const;

const expandTilde = (input: string): string =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/u, '')) : input;

const isoStamp = (): string => new Date().toISOString().replace(/[:.]/gu, '-');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const waitForEnter = async (label: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(label);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
};

const withTimeout = async <T>(
  label: string,
  task: Promise<T>,
  timeoutMs = 10_000,
): Promise<T | { readonly timeout: true; readonly label: string; readonly timeoutMs: number }> =>
  await Promise.race([
    task,
    new Promise<{ readonly timeout: true; readonly label: string; readonly timeoutMs: number }>(
      (resolve) => {
        setTimeout(() => {
          resolve({ timeout: true, label, timeoutMs });
        }, timeoutMs);
      },
    ),
  ]);

const apiGet = async (comp: TestCompanion, requestPath: string): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${String(comp.port)}${requestPath}`, {
      headers: { 'x-bac-bridge-key': comp.bridgeKey },
      signal: controller.signal,
    });
    if (!res.ok)
      throw new Error(`GET ${requestPath} failed: ${String(res.status)} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const apiPost = async (
  comp: TestCompanion,
  requestPath: string,
  body: unknown,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${String(comp.port)}${requestPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bac-bridge-key': comp.bridgeKey,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok)
      throw new Error(`POST ${requestPath} failed: ${String(res.status)} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const openPrivacyGate = async (comp: TestCompanion, gate: string): Promise<void> => {
  await apiPost(comp, '/v1/privacy/events', {
    type: 'privacy.gate.flipped',
    payload: {
      payloadVersion: 1,
      gate,
      state: 'open',
      actor: 'user',
      reason: 'manual-l5-recorder',
    },
  });
};

const openRecorderSidepanel = async (
  runtime: ExtensionRuntime,
  comp: TestCompanion,
  activeWorkstreamId: string,
): Promise<Page> => {
  const page = await runtime.context.newPage();
  await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  await runtime.seedStorage(page, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: {
      companion: { port: comp.port, bridgeKey: comp.bridgeKey },
      autoTrack: true,
      siteToggles: { chatgpt: true, claude: true, gemini: true, codex: true },
      notifyOnQueueComplete: true,
    },
    'sidetrack.timeline.enabled': true,
    'sidetrack.activeWorkstreamId': activeWorkstreamId,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  return page;
};

const reinitializeTimeline = async (runtime: ExtensionRuntime, panel: Page): Promise<void> => {
  const result = (await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.timeline.reinit',
  })) as { readonly ok?: boolean; readonly error?: string } | null;
  if (result?.ok !== true) {
    throw new Error(result?.error ?? 'timeline reinit failed');
  }
  const gateChanged = (await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.privacy.gateChanged',
  })) as { readonly ok?: boolean; readonly error?: string } | null;
  if (gateChanged?.ok !== true) {
    throw new Error(gateChanged?.error ?? 'privacy gateChanged failed');
  }
};

const grantDeeperPageAccessIfNeeded = async (panel: Page): Promise<void> => {
  await panel.getByRole('button', { name: 'Settings' }).click();
  const timelineSection = panel.getByTestId('settings-timeline-section');
  await expect(timelineSection).toBeVisible({ timeout: 10_000 });
  await timelineSection.scrollIntoViewIfNeeded();
  const grantButton = panel.getByTestId('settings-timeline-grant-permission');
  if (await grantButton.isVisible().catch(() => false)) {
    await grantButton.click();
  }
  await panel.locator('button.btn.btn-ghost', { hasText: 'Close' }).click();
};

const drainRuntime = async (
  runtime: ExtensionRuntime,
  panel: Page,
): Promise<{
  readonly timeline: unknown;
  readonly edgeEvents: unknown;
}> => {
  const timeline = await withTimeout(
    'sidetrack.timeline.force-drain',
    runtime.sendRuntimeMessage(panel, {
      type: 'sidetrack.timeline.force-drain',
    }),
    15_000,
  );
  const edgeEvents = await withTimeout(
    'sidetrack.edge-events.force-drain',
    runtime.sendRuntimeMessage(panel, {
      type: 'sidetrack.edge-events.force-drain',
    }),
    15_000,
  );
  return { timeline, edgeEvents };
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const createLaunchpad = async (
  artifactsDir: string,
  input: {
    readonly securityWorkstreamId: string;
    readonly switchboardWorkstreamId: string;
    readonly browserPanelUrl: string;
    readonly reviewerPanelUrl: string;
  },
): Promise<string> => {
  const linkSections = (flow: FlowKey): string =>
    VISIT_LINKS.filter((link) => link.flow === flow)
      .map(
        (link) => `
          <li>
            <a href="${link.url}" target="_blank" rel="noreferrer">${link.title}</a>
            <small>${link.note}</small>
          </li>`,
      )
      .join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Sidetrack L5 manual recorder launchpad</title>
  <style>
    body { font: 15px/1.45 system-ui, sans-serif; margin: 32px; max-width: 1120px; }
    header { display: flex; align-items: baseline; gap: 16px; border-bottom: 1px solid #ddd; }
    h1 { font-size: 24px; margin: 0 0 12px; }
    h2 { font-size: 18px; margin: 28px 0 8px; }
    ol, ul { padding-left: 24px; }
    li { margin: 8px 0; }
    a { color: #0b57d0; }
    small { display: block; color: #555; margin-top: 2px; }
    code { background: #f4f4f4; padding: 2px 5px; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  </style>
</head>
<body>
  <header>
    <h1>Sidetrack L5 manual recorder</h1>
    <span>Artifacts are written locally under <code>${artifactsDir}</code>.</span>
  </header>
  <h2>Before clicking links</h2>
  <ol>
    <li>Use the Sidetrack panel tab for Browser A to keep the active workstream aligned.</li>
    <li>Security flow workstream id: <code>${input.securityWorkstreamId}</code>.</li>
    <li>Switchboard flow workstream id: <code>${input.switchboardWorkstreamId}</code>.</li>
    <li>Browser A panel: <a href="${input.browserPanelUrl}" target="_blank" rel="noreferrer">${input.browserPanelUrl}</a>.</li>
    <li>Reviewer panel: <a href="${input.reviewerPanelUrl}" target="_blank" rel="noreferrer">${input.reviewerPanelUrl}</a>.</li>
  </ol>
  <div class="grid">
    <section>
      <h2>Flow A: security research</h2>
      <ul>${linkSections('security')}</ul>
    </section>
    <section>
      <h2>Flow B: Switchboard PR review</h2>
      <ul>${linkSections('switchboard')}</ul>
    </section>
  </div>
</body>
</html>
`;
  const launchpadPath = path.join(artifactsDir, 'launchpad.html');
  await writeFile(launchpadPath, html, 'utf8');
  return `file://${launchpadPath}`;
};

const dumpCompanionState = async (
  artifactsDir: string,
  label: string,
  comp: TestCompanion,
): Promise<void> => {
  const targetDir = path.join(artifactsDir, 'companion', label);
  await mkdir(targetDir, { recursive: true });
  const endpoints = [
    '/v1/timeline',
    '/v1/connections',
    '/v1/feedback/projection',
    '/v1/privacy/projection',
    '/v1/collectors',
    '/v1/dispatches',
  ] as const;
  for (const endpoint of endpoints) {
    const file = endpoint.replace(/^\/v1\//u, '').replace(/[^a-z0-9]+/giu, '-');
    const value = await apiGet(comp, endpoint).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    await writeJson(path.join(targetDir, `${file}.json`), value);
  }
};

const renderConnectionsForReview = async (
  panel: Page,
  workstreamId: string,
  artifactsDir: string,
  label: string,
): Promise<void> => {
  await panel.getByRole('tab', { name: 'Connections' }).click();
  await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 20_000 });
  const input = panel.getByTestId('connections-anchor-input');
  await input.click();
  await input.fill(`workstream:${workstreamId}`);
  await input.press('Enter');
  await panel.getByTestId('connections-hops-select').selectOption('3');
  await panel.getByTestId('connections-view').screenshot({
    path: path.join(artifactsDir, `${label}-connections.png`),
  });
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

const writeCollectorDemo = async (
  vaultPath: string,
  input: {
    readonly dispatchId: string;
    readonly codingSessionId: string;
  },
): Promise<void> => {
  const manifestDir = path.join(vaultPath, '_BAC', 'collectors', CODEX_COLLECTOR_ID);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(path.join(manifestDir, 'collector.toml'), collectorManifest(), 'utf8');
  const now = Date.now();
  const runId = `manual-${randomUUID()}`;
  const line = (eventType: 'session_started' | 'session_turn', offsetMs: number): string =>
    JSON.stringify({
      collector_id: CODEX_COLLECTOR_ID,
      event_type: eventType,
      payload_version: 1,
      emitted_at: new Date(now + offsetMs).toISOString(),
      collector_version: '0.1.0',
      collector_run_id: runId,
      source_record_id: `${input.codingSessionId}:${eventType}`,
      dimensions: {
        dispatchId: input.dispatchId,
        codingSessionId: input.codingSessionId,
      },
      payload:
        eventType === 'session_started'
          ? {
              session_id: input.codingSessionId,
              started_at: new Date(now + offsetMs).toISOString(),
              cwd: packageRoot,
              model: 'manual-recorder',
            }
          : {
              session_id: input.codingSessionId,
              turn_index: 0,
              started_at: new Date(now + offsetMs).toISOString(),
              completed_at: new Date(now + offsetMs + 1000).toISOString(),
              model: 'manual-recorder',
              prompt_text: `Manual recorder dispatch ${input.dispatchId}`,
              response_text: 'Manual coding-agent turn observed for L5 result review.',
              tool_call_count: 1,
              exec_command_count: 1,
            },
    });
  const inboxDir = path.join(vaultPath, '_BAC', 'inbox', CODEX_COLLECTOR_ID);
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    path.join(inboxDir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
    `${line('session_started', -5000)}\n${line('session_turn', -3000)}\n`,
    'utf8',
  );
};

const waitForConnections = async (
  comp: TestCompanion,
  predicate: (env: ConnectionsEnvelope) => boolean,
  timeoutMs = 60_000,
): Promise<ConnectionsEnvelope> => {
  const started = Date.now();
  let latest: ConnectionsEnvelope = {};
  while (Date.now() - started < timeoutMs) {
    latest = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return latest;
};

test.describe('manual L5 full-browser recorder', () => {
  test('records user-driven real-page activity for L5 fixture hardening', async () => {
    test.setTimeout(0);
    process.env.SIDETRACK_E2E_HEADLESS = '0';

    const profileDir = expandTilde(process.env[PROFILE_ENV] ?? DEFAULT_PROFILE);
    const artifactsDir = path.join(tmpdir(), 'sidetrack-manual-l5', isoStamp());
    await mkdir(artifactsDir, { recursive: true });

    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;
    try {
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
        userDataDir: profileDir,
        extraHostPermissions: RECORDER_HOST_PERMISSIONS,
      });
      const reviewerProfile = await mkdtemp(path.join(tmpdir(), 'sidetrack-manual-l5-reviewer-'));
      runtimeB = await launchExtensionRuntime({
        userDataDir: reviewerProfile,
        extraHostPermissions: RECORDER_HOST_PERMISSIONS,
      });

      const recorder = new ManualRecorder(runtimeA.context, artifactsDir);
      await recorder.install();

      await openPrivacyGate(companionA, 'timeline');
      await openPrivacyGate(companionA, 'engagement');
      await openPrivacyGate(companionB, 'timeline');
      await openPrivacyGate(companionB, 'engagement');

      const wsSecurityRes = (await apiPost(companionA, '/v1/workstreams', {
        title: 'Copy-fail Linux security research',
      })) as { readonly data?: { readonly bac_id?: unknown } };
      const wsSwitchboardRes = (await apiPost(companionA, '/v1/workstreams', {
        title: 'Switchboard PR review',
      })) as { readonly data?: { readonly bac_id?: unknown } };
      const wsSecurityId = wsSecurityRes.data?.bac_id;
      const wsSwitchboardId = wsSwitchboardRes.data?.bac_id;
      if (typeof wsSecurityId !== 'string' || typeof wsSwitchboardId !== 'string') {
        throw new Error('workstream creation did not return ids');
      }

      const panelA = await openRecorderSidepanel(runtimeA, companionA, wsSecurityId);
      const panelB = await openRecorderSidepanel(runtimeB, companionB, wsSecurityId);
      await reinitializeTimeline(runtimeA, panelA);
      await reinitializeTimeline(runtimeB, panelB);
      await grantDeeperPageAccessIfNeeded(panelA).catch((error: unknown) => {
        console.warn(
          `[manual-l5] permission auto-grant did not complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      await recorder.record({
        kind: 'manual-session-ready',
        payload: {
          artifactsDir,
          profileDir,
          securityWorkstreamId: wsSecurityId,
          switchboardWorkstreamId: wsSwitchboardId,
          companionA: {
            port: companionA.port,
            vaultPath: companionA.vaultPath,
          },
          companionB: {
            port: companionB.port,
            vaultPath: companionB.vaultPath,
          },
        },
      });

      const launchpadUrl = await createLaunchpad(artifactsDir, {
        securityWorkstreamId: wsSecurityId,
        switchboardWorkstreamId: wsSwitchboardId,
        browserPanelUrl: `chrome-extension://${runtimeA.extensionId}/sidepanel.html`,
        reviewerPanelUrl: `chrome-extension://${runtimeB.extensionId}/sidepanel.html`,
      });
      const launchpad = await runtimeA.context.newPage();
      await launchpad.goto(launchpadUrl, { waitUntil: 'domcontentloaded' });
      await launchpad.bringToFront();

      const banner = `
================================================================
 SIDETRACK L5 MANUAL RECORDER READY
================================================================

 Browser A profile: ${profileDir}
 Browser A panel  : chrome-extension://${runtimeA.extensionId}/sidepanel.html
 Reviewer panel   : chrome-extension://${runtimeB.extensionId}/sidepanel.html

 Companion A      : http://127.0.0.1:${String(companionA.port)}
 Companion B      : http://127.0.0.1:${String(companionB.port)}
 Artifacts        : ${artifactsDir}

 Workstreams:
   Flow A security     : ${wsSecurityId}
   Flow B Switchboard  : ${wsSwitchboardId}

 Manual steps:
   1. Use the launchpad tab to click links. Cmd-click or middle-click
      if you want a link to open in a new tab.
   2. Keep the Sidetrack panel's active workstream on Flow A while
      doing HN/xint/google/ChatGPT/copy.fail/GitHub exploit work.
   3. Switch the active workstream to Flow B before GitHub
      switchboard/pulls/ChatGPT/YouTube/Gemini.
   4. For the dispatch direction, copy a useful snippet from
      copy.fail and paste it into a GitHub/coding-agent input if the
      page offers one. The recorder logs copy/paste text excerpts.
   5. Tell Codex "done" when finished. I will stop the recorder,
      drain Sidetrack, dump connections/timeline state, and summarize
      the observed activities for confirmation.

No video is recorded. Artifacts are JSONL events, page text/html
dumps, visible screenshots, and companion/plugin result JSON.
================================================================
`;
      // eslint-disable-next-line no-console
      console.log(banner);

      await waitForEnter('[manual-l5] Waiting. Send Enter after the user says done...');

      await recorder.snapshotAll('manual-finished');
      await recorder.writeSummary();
      const drainA = await drainRuntime(runtimeA, panelA);
      const drainB = await drainRuntime(runtimeB, panelB);
      await writeJson(path.join(artifactsDir, 'drain-results.json'), { A: drainA, B: drainB });

      const dispatchResponse = (await apiPost(companionA, '/v1/dispatches', {
        kind: 'coding',
        target: { provider: 'codex', mode: 'paste' },
        workstreamId: wsSecurityId,
        title: 'Manual L5 copy.fail coding dispatch',
        body: 'Manual recorder observed copy.fail to coding-agent dispatch flow.',
        createdAt: new Date().toISOString(),
        mcpRequest: {
          codingSessionId: `manual-l5-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          approval: 'manual-recorder',
          requestedAt: new Date().toISOString(),
        },
      })) as { readonly data?: { readonly bac_id?: unknown; readonly mcpRequest?: unknown } };
      const dispatchId =
        typeof dispatchResponse.data?.bac_id === 'string' ? dispatchResponse.data.bac_id : null;
      const rawMcpRequest = dispatchResponse.data?.mcpRequest;
      const mcpRequest = isRecord(rawMcpRequest) ? rawMcpRequest : {};
      const codingSessionId =
        typeof mcpRequest.codingSessionId === 'string'
          ? mcpRequest.codingSessionId
          : `manual-l5-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      if (dispatchId !== null) {
        await writeCollectorDemo(companionA.vaultPath, { dispatchId, codingSessionId });
      }

      await waitForConnections(
        companionB,
        (env) => {
          const edges = env.data?.snapshot?.edges ?? [];
          return (
            edges.some((edge) => edge.kind === 'visit_in_workstream') &&
            (dispatchId === null ||
              edges.some(
                (edge) =>
                  edge.kind === 'dispatch_in_workstream' &&
                  edge.fromNodeId === `dispatch:${dispatchId}`,
              ))
          );
        },
        20_000,
      );

      await dumpCompanionState(artifactsDir, 'browser-a', companionA);
      await dumpCompanionState(artifactsDir, 'reviewer-b', companionB);
      await renderConnectionsForReview(panelB, wsSecurityId, artifactsDir, 'security').catch(
        () => undefined,
      );
      await renderConnectionsForReview(panelB, wsSwitchboardId, artifactsDir, 'switchboard').catch(
        () => undefined,
      );
      await recorder.snapshotPage(panelA, 'panel-a-final');
      await recorder.snapshotPage(panelB, 'panel-b-final');
      const summaryPath = path.join(artifactsDir, 'activity-summary.md');
      const files = await readdir(artifactsDir);
      // eslint-disable-next-line no-console
      console.log(`
================================================================
 SIDETRACK L5 MANUAL RECORDER DUMPED ARTIFACTS
================================================================

 Summary:   ${summaryPath}
 Artifacts: ${artifactsDir}
 Top-level: ${files.join(', ')}

The browser is still open for review. Codex can now read the
summary and confirm the observed activity list with the user.

Send Enter a second time to close browsers and stop companions.
================================================================
`);

      await waitForEnter('[manual-l5] Waiting to close. Send Enter when review is complete...');
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});
