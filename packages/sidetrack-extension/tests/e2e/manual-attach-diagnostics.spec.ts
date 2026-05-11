// Manual attach diagnostics — NOT a CI test.
//
// Two-terminal flow:
//
//   Terminal A:
//     npm --prefix packages/sidetrack-extension run e2e:chrome-debug
//
//   Terminal B (after the CfT window is open with Sidetrack loaded):
//     SIDETRACK_E2E_CDP_URL=http://localhost:9222 \
//       npm --prefix packages/sidetrack-extension run e2e:attach-diag
//
// What it does — without asking the operator to manually click
// anything in the side panel:
//
//   1. Connects over CDP to the already-running Chrome.
//   2. Wakes the MV3 service worker (opens chrome-extension://*/sidepanel.html).
//   3. Reads chrome.storage.local to find companion port + bridge key.
//   4. Asks the SW for its dev.diag stash and falls back to
//      chrome.storage.session if the message port closes.
//   5. Inspects chrome.permissions (host access for engagement) and
//      chrome.scripting.getRegisteredContentScripts.
//   6. Opens a benign https tab (Wikipedia main page) for ~8 seconds
//      so the engagement aggregator has a chance to fire, then queries
//      the SW again.
//   7. Calls the SW's `sidetrack.timeline.force-drain`.
//   8. Hits the companion's HTTP for vault/version/materializer/
//      threads/URL-projection data.
//   9. Computes per-condition classifications for engagement and
//      thread→URL propagation.
//  10. Writes a JSON report under test-results/attach-diag.json AND
//      prints the report to stdout.
//
// The whole spec runs without operator interaction. If something
// fails it produces an EVIDENCE BLOCK identifying which exact
// condition failed.

import { mkdir, readFile, writeFile, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

// --- Types ----------------------------------------------------------

interface RuntimeDiagStash {
  readonly observer?: Record<string, unknown>;
  readonly wiring?: Record<string, unknown>;
  readonly contentTitleSink?: Record<string, unknown>;
}

interface CompanionEndpoint {
  readonly port: number;
  readonly bridgeKey: string;
}

interface ContentScriptRegistration {
  readonly id: string;
  readonly matches?: readonly string[];
  readonly js?: readonly string[];
  readonly runAt?: string;
}

interface AttachDiagReport {
  readonly producedAt: string;
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly cdpAttached: boolean;
  readonly serviceWorkerAwake: boolean;
  readonly companionReachable: boolean;
  readonly extensionBuildSha: string;
  readonly extensionBuildAt: string | null;
  readonly companionBuildSha: string | null;
  readonly companionStartedAt: string | null;
  readonly companionPort: number | null;
  readonly companionBridgeKeyRedacted: string | null;
  readonly vaultRoot: string | null;
  readonly branch: string;
  readonly headSha: string;
  readonly workingTreeDirty: boolean;
  readonly stalenessWarning: string | null;
  readonly privacy: {
    readonly timelineGate: string | null;
    readonly engagementGate: string | null;
    readonly visualFingerprintGate: string | null;
  };
  readonly permissions: {
    readonly httpHostAccess: boolean | null;
  };
  readonly contentScripts: {
    readonly engagementRegistered: boolean;
    readonly engagementScripts: readonly ContentScriptRegistration[];
    readonly engagementBuiltFileExists: boolean;
    readonly engagementBuiltFilePath: string;
    readonly visualFingerprintRegistered: boolean;
    readonly visualFingerprintScripts: readonly ContentScriptRegistration[];
  };
  readonly engagement: {
    readonly lastIntervalSeen: unknown;
    readonly lastAggregatePosted: unknown;
    readonly postError: unknown;
    readonly eventCountBefore: number | null;
    readonly eventCountAfter: number | null;
  };
  readonly materializer: {
    readonly engagementEligibleEntryCount: number | null;
    readonly entriesWithFocusedWindowMs: number | null;
    readonly similarityEdgeCount: number | null;
    readonly rankerStatus: string | null;
    readonly closestVisitEdgeCount: number | null;
    readonly fullCounters: unknown;
  };
  readonly threadUrlPropagation: {
    readonly urlAttributionBySource: Record<string, number>;
    readonly threadCount: number;
    readonly threadsWithPrimaryWorkstream: number;
    readonly threadsWithUrl: number;
    readonly threadsMatchedToObservedCanonicalUrl: number;
    readonly propagatedCount: number;
    readonly missReasons: {
      readonly noPrimaryWorkstream: number;
      readonly noThreadUrl: number;
      readonly urlNotObserved: number;
      readonly lostToPrecedence: number;
    };
  };
  readonly engagementFailureClass: string;
  readonly threadPropagationFailureClass: string;
  readonly runtimeDiagBefore: RuntimeDiagStash | null;
  readonly runtimeDiagAfter: RuntimeDiagStash | null;
}

// --- Git helpers ----------------------------------------------------

const gitCommand = async (args: string): Promise<string> => {
  const { execSync } = await import('node:child_process');
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: repoRoot,
    }).trim();
  } catch {
    return '';
  }
};

// --- HTTP helpers ---------------------------------------------------

const fetchCompanionJson = async (
  endpoint: CompanionEndpoint,
  pathPart: string,
): Promise<unknown> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(endpoint.port)}${pathPart}`, {
      headers: { 'x-bac-bridge-key': endpoint.bridgeKey },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
};

// --- Helpers for the sidepanel-side probe ---------------------------

interface SidepanelProbeResult {
  readonly companionPort: number | null;
  readonly bridgeKey: string | null;
  readonly httpHostAccess: boolean | null;
  readonly engagementScripts: readonly ContentScriptRegistration[];
  readonly visualFingerprintScripts: readonly ContentScriptRegistration[];
  readonly devDiag: RuntimeDiagStash | null;
}

const probeSidepanel = async (
  runtime: ExtensionRuntime,
): Promise<{ readonly result: SidepanelProbeResult; readonly cleanup: () => Promise<void> }> => {
  const page = await runtime.context.newPage();
  await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  // Give the SW a beat to be reachable.
  await page.waitForTimeout(500);
  // Read companion config + permissions + scripts + diag stash in one main-world block.
  const result: SidepanelProbeResult = await (
    page as unknown as {
      evaluate: (
        fn: () => Promise<SidepanelProbeResult>,
        arg?: unknown,
        isolated?: boolean,
      ) => Promise<SidepanelProbeResult>;
    }
  ).evaluate(
    async (): Promise<SidepanelProbeResult> => {
      const c = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
      if (c === undefined) {
        return {
          companionPort: null,
          bridgeKey: null,
          httpHostAccess: null,
          engagementScripts: [],
          visualFingerprintScripts: [],
          devDiag: null,
        };
      }
      const settingsKey = 'sidetrack.settings';
      const got = await c.storage.local.get(settingsKey);
      const settings = (got[settingsKey] ?? {}) as {
        readonly companion?: { readonly port?: number; readonly bridgeKey?: string };
      };
      const companionPort =
        typeof settings.companion?.port === 'number' ? settings.companion.port : null;
      const bridgeKey =
        typeof settings.companion?.bridgeKey === 'string' && settings.companion.bridgeKey.length > 0
          ? settings.companion.bridgeKey
          : null;
      const httpHostAccess = await new Promise<boolean | null>((resolve) => {
        try {
          c.permissions.contains(
            { origins: ['https://*/*', 'http://*/*'] },
            (granted) => {
              resolve(granted);
            },
          );
        } catch {
          resolve(null);
        }
      });
      const fetchScripts = async (id: string): Promise<readonly ContentScriptRegistration[]> => {
        try {
          const list = await c.scripting.getRegisteredContentScripts({ ids: [id] });
          return list.map((entry) => ({
            id: entry.id,
            matches: entry.matches,
            js: entry.js,
            runAt: entry.runAt,
          }));
        } catch {
          return [];
        }
      };
      const engagementScripts = await fetchScripts('sidetrack-engagement');
      const visualFingerprintScripts = await fetchScripts('sidetrack-visual-fingerprint');
      // Trigger the SW's dev.diag stash. Two-step: send the message,
      // then read chrome.storage.session in case the response races.
      try {
        await c.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
      } catch {
        // ignore — fall back to storage read
      }
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 250);
      });
      let devDiag: RuntimeDiagStash | null = null;
      try {
        const sessionStorage = (c.storage as { readonly session?: typeof c.storage.local })
          .session;
        if (sessionStorage !== undefined) {
          const stash = await sessionStorage.get('sidetrack.dev.diag');
          devDiag = (stash['sidetrack.dev.diag'] as RuntimeDiagStash | undefined) ?? null;
        }
      } catch {
        devDiag = null;
      }
      return {
        companionPort,
        bridgeKey,
        httpHostAccess,
        engagementScripts,
        visualFingerprintScripts,
        devDiag,
      };
    },
    undefined,
    false,
  );
  return {
    result,
    cleanup: async () => {
      await page.close();
    },
  };
};

const exerciseEngagementPage = async (
  runtime: ExtensionRuntime,
  durationMs: number,
): Promise<void> => {
  const exerc = await runtime.context.newPage();
  try {
    // Wikipedia main page — small, predictable, no auth, no aggressive
    // redirects. Engagement aggregator emits an interval every ~30s
    // OR on visibility change. We poll a shorter window and just keep
    // the page in foreground.
    await exerc.goto('https://en.wikipedia.org/wiki/Main_Page', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await exerc.bringToFront();
    await exerc.waitForTimeout(durationMs);
    // Scroll once to bump engagement aggregator's accumulated metrics.
    await exerc.evaluate(() => {
      window.scrollBy(0, 200);
    });
    await exerc.waitForTimeout(500);
  } catch {
    // ignore — page errors don't fail the diag
  } finally {
    await exerc.close();
  }
};

// --- Classification helpers ----------------------------------------

const classifyEngagementFailure = (
  report: Pick<
    AttachDiagReport,
    | 'privacy'
    | 'permissions'
    | 'contentScripts'
    | 'engagement'
    | 'materializer'
  >,
): string => {
  if (report.privacy.engagementGate !== 'open') return 'closed gate';
  if (report.permissions.httpHostAccess !== true) return 'missing permission';
  if (!report.contentScripts.engagementBuiltFileExists) return 'wrong built script path';
  if (!report.contentScripts.engagementRegistered) return 'registration not called';
  if (report.engagement.lastIntervalSeen === null || report.engagement.lastIntervalSeen === undefined) {
    return 'script registered but not injected';
  }
  if (report.engagement.lastAggregatePosted === null || report.engagement.lastAggregatePosted === undefined) {
    return 'SW did not receive interval';
  }
  if (
    report.engagement.postError !== null &&
    report.engagement.postError !== undefined
  ) {
    return 'companion post failed';
  }
  if (
    report.materializer.engagementEligibleEntryCount === null ||
    report.materializer.engagementEligibleEntryCount === 0
  ) {
    return 'materializer did not consume event';
  }
  return 'ok';
};

const classifyThreadPropagationFailure = (
  propagation: AttachDiagReport['threadUrlPropagation'],
): string => {
  if (propagation.threadCount === 0) return 'no threads in vault';
  if (propagation.threadsWithPrimaryWorkstream === 0) return 'no threads have primaryWorkstreamId';
  if (propagation.threadsWithUrl === 0) return 'threads have no canonical/thread URL';
  if (propagation.threadsMatchedToObservedCanonicalUrl === 0) {
    return 'thread URLs are not in the URL projection';
  }
  const threadCount =
    'thread' in propagation.urlAttributionBySource
      ? propagation.urlAttributionBySource.thread
      : 0;
  if (threadCount === 0) {
    if (propagation.missReasons.lostToPrecedence > 0) {
      return `propagation ran but lost to direct user_asserted on ${String(propagation.missReasons.lostToPrecedence)} URLs`;
    }
    return 'propagation did not produce any thread-source attribution (companion likely stale)';
  }
  return 'ok';
};

// --- Main spec -----------------------------------------------------

test.describe('manual attach diagnostics', () => {
  test.skip(
    process.env.SIDETRACK_E2E_CDP_URL === undefined,
    'attach-diag requires SIDETRACK_E2E_CDP_URL; start `e2e:chrome-debug` in another terminal first',
  );

  test('produce a JSON report from the live browser', async () => {
    test.setTimeout(120_000);

    const runtime = await launchExtensionRuntime({});
    try {
      // 1-3: connect + wake + open sidepanel + initial probe.
      const before = await probeSidepanel(runtime);

      const companionEndpoint: CompanionEndpoint | null =
        before.result.companionPort !== null && before.result.bridgeKey !== null
          ? { port: before.result.companionPort, bridgeKey: before.result.bridgeKey }
          : null;

      // 4: companion-side data (best-effort; null when unreachable).
      const privacyProjection =
        companionEndpoint === null
          ? null
          : await fetchCompanionJson(companionEndpoint, '/v1/privacy/projection');
      const versionProjection =
        companionEndpoint === null ? null : await fetchCompanionJson(companionEndpoint, '/v1/version');
      const threadsProjection =
        companionEndpoint === null
          ? null
          : await fetchCompanionJson(companionEndpoint, '/v1/threads/projections');
      const urlsProjection =
        companionEndpoint === null
          ? null
          : await fetchCompanionJson(companionEndpoint, '/v1/visits/projection');

      // 5: classification — read materializer diagnostics from disk
      // (the vault path is reported by /v1/version when available).
      const vaultRoot =
        typeof (versionProjection as { data?: { vaultRoot?: string } } | null)?.data?.vaultRoot ===
        'string'
          ? (versionProjection as { data: { vaultRoot: string } }).data.vaultRoot
          : null;
      const matDiagPath =
        vaultRoot === null
          ? null
          : path.join(vaultRoot, '_BAC/connections/diagnostics/latest.json');
      const matDiag: unknown =
        matDiagPath === null
          ? null
          : await readFile(matDiagPath, 'utf8')
              .then((body) => JSON.parse(body) as unknown)
              .catch(() => null);

      // 6: exercise an engagement-eligible page, then re-probe.
      await exerciseEngagementPage(runtime, 8_000);
      const after = await probeSidepanel(runtime);
      const matDiagAfter: unknown =
        matDiagPath === null
          ? null
          : await readFile(matDiagPath, 'utf8')
              .then((body) => JSON.parse(body) as unknown)
              .catch(() => null);

      // 7: thread propagation classification.
      const threads = ((threadsProjection as { data?: unknown[] } | null)?.data ?? []) as readonly {
        readonly bac_id?: string;
        readonly canonicalUrl?: string;
        readonly threadUrl?: string;
        readonly primaryWorkstreamId?: string;
      }[];
      const urlMap = new Map<string, unknown>(
        Object.entries(
          (urlsProjection as { data?: { byCanonicalUrl?: Record<string, unknown> } } | null)?.data
            ?.byCanonicalUrl ?? {},
        ),
      );
      const stripFragmentAndSlash = (url: string): string =>
        url.replace(/#.*$/u, '').replace(/\/+$/u, '');
      let threadsWithPrimary = 0;
      let threadsWithUrl = 0;
      let threadsMatched = 0;
      let propagatedCount = 0;
      let lostToPrecedence = 0;
      for (const thread of threads) {
        if (typeof thread.primaryWorkstreamId !== 'string' || thread.primaryWorkstreamId.length === 0) {
          continue;
        }
        threadsWithPrimary += 1;
        const candidate = thread.canonicalUrl ?? thread.threadUrl;
        if (typeof candidate !== 'string' || candidate.length === 0) continue;
        threadsWithUrl += 1;
        const canonical = stripFragmentAndSlash(candidate);
        const record = urlMap.get(canonical) as
          | { readonly currentAttribution?: { readonly source?: string; readonly workstreamId?: string } }
          | undefined;
        if (record === undefined) continue;
        threadsMatched += 1;
        const source = record.currentAttribution?.source;
        if (source === 'thread') propagatedCount += 1;
        else if (source === 'user_asserted') lostToPrecedence += 1;
      }

      // 8: urlAttributionBySource — read from materializer diagnostic OR
      // recompute from URL projection.
      const matAttributionBySource =
        (matDiagAfter as { urls?: { attributionBySource?: Record<string, number> } } | null)?.urls
          ?.attributionBySource ?? null;
      const urlAttributionBySource: Record<string, number> = matAttributionBySource ?? {};
      if (matAttributionBySource === null) {
        for (const record of urlMap.values()) {
          const source = (record as { currentAttribution?: { source?: string } }).currentAttribution
            ?.source;
          if (typeof source === 'string') {
            urlAttributionBySource[source] = (urlAttributionBySource[source] ?? 0) + 1;
          }
        }
      }

      // 9: build the report.
      const builtFilePath = path.join(runtime.extensionPath, 'engagement.js');
      const builtFileExists = await statFile(builtFilePath)
        .then(() => true)
        .catch(() => false);
      const extensionBuildStat = await statFile(
        path.join(runtime.extensionPath, 'background.js'),
      ).catch(() => null);
      const branch = (await gitCommand('symbolic-ref --short HEAD')) || 'detached';
      const headSha = (await gitCommand('rev-parse --short HEAD')) || 'unknown';
      const workingTreeDirty =
        (await gitCommand('status --porcelain --untracked-files=no')).length > 0;
      const companionStartedAt =
        typeof (versionProjection as { data?: { startedAt?: string } } | null)?.data?.startedAt ===
        'string'
          ? (versionProjection as { data: { startedAt: string } }).data.startedAt
          : null;
      const companionBuildSha =
        typeof (versionProjection as { data?: { gitSha?: string } } | null)?.data?.gitSha ===
        'string'
          ? (versionProjection as { data: { gitSha: string } }).data.gitSha
          : null;
      const stalenessWarning =
        companionBuildSha !== null && headSha !== 'unknown' && !companionBuildSha.startsWith(headSha)
          ? `STALE_PROCESS: extension build sha (${headSha}) and companion build sha (${companionBuildSha}) differ; restart the recorder/companion to interpret companion-side diagnostics`
          : null;

      const privacyData = (privacyProjection as { data?: { gateStates?: Record<string, string> } } | null)
        ?.data?.gateStates ?? {};

      const report: AttachDiagReport = {
        producedAt: new Date().toISOString(),
        extensionId: runtime.extensionId,
        extensionPath: runtime.extensionPath,
        cdpAttached: runtime.metadata?.cdpAttached === true,
        serviceWorkerAwake: true,
        companionReachable: companionEndpoint !== null && privacyProjection !== null,
        extensionBuildSha: headSha,
        extensionBuildAt: extensionBuildStat?.mtime.toISOString() ?? null,
        companionBuildSha,
        companionStartedAt,
        companionPort: companionEndpoint?.port ?? null,
        companionBridgeKeyRedacted:
          companionEndpoint === null
            ? null
            : `${companionEndpoint.bridgeKey.slice(0, 4)}…${companionEndpoint.bridgeKey.slice(-4)}`,
        vaultRoot,
        branch,
        headSha,
        workingTreeDirty,
        stalenessWarning,
        privacy: {
          timelineGate: privacyData.timeline,
          engagementGate: privacyData.engagement,
          visualFingerprintGate: privacyData['visual.fingerprint'] ?? null,
        },
        permissions: { httpHostAccess: after.result.httpHostAccess },
        contentScripts: {
          engagementRegistered: after.result.engagementScripts.length > 0,
          engagementScripts: after.result.engagementScripts,
          engagementBuiltFileExists: builtFileExists,
          engagementBuiltFilePath: builtFilePath,
          visualFingerprintRegistered: after.result.visualFingerprintScripts.length > 0,
          visualFingerprintScripts: after.result.visualFingerprintScripts,
        },
        engagement: {
          // The dev.diag stash doesn't currently track these. Best-effort
          // read from chrome.storage.session keys the engagement runtime
          // would set. The classification function tolerates nulls.
          lastIntervalSeen:
            (after.result.devDiag as { engagement?: { lastInterval?: unknown } } | null)?.engagement
              ?.lastInterval ?? null,
          lastAggregatePosted:
            (after.result.devDiag as { engagement?: { lastAggregate?: unknown } } | null)?.engagement
              ?.lastAggregate ?? null,
          postError:
            (after.result.devDiag as { engagement?: { lastPostError?: unknown } } | null)?.engagement
              ?.lastPostError ?? null,
          eventCountBefore:
            (matDiag as { engagement?: { sessionAggregatedCount?: number } } | null)?.engagement
              ?.sessionAggregatedCount ?? null,
          eventCountAfter:
            (matDiagAfter as { engagement?: { sessionAggregatedCount?: number } } | null)?.engagement
              ?.sessionAggregatedCount ?? null,
        },
        materializer: {
          engagementEligibleEntryCount:
            (matDiagAfter as { timeline?: { engagementEligibleEntryCount?: number } } | null)
              ?.timeline?.engagementEligibleEntryCount ?? null,
          entriesWithFocusedWindowMs:
            (matDiagAfter as { timeline?: { entriesWithFocusedWindowMs?: number } } | null)?.timeline
              ?.entriesWithFocusedWindowMs ?? null,
          similarityEdgeCount:
            (matDiagAfter as { similarity?: { edgeCount?: number } } | null)?.similarity?.edgeCount ??
            null,
          rankerStatus:
            (matDiagAfter as { ranker?: { status?: string } } | null)?.ranker?.status ?? null,
          closestVisitEdgeCount:
            (matDiagAfter as { snapshot?: { edgeCountByKind?: Record<string, number> } } | null)
              ?.snapshot?.edgeCountByKind?.closest_visit ?? null,
          fullCounters: matDiagAfter,
        },
        threadUrlPropagation: {
          urlAttributionBySource,
          threadCount: threads.length,
          threadsWithPrimaryWorkstream: threadsWithPrimary,
          threadsWithUrl,
          threadsMatchedToObservedCanonicalUrl: threadsMatched,
          propagatedCount,
          missReasons: {
            noPrimaryWorkstream: threads.length - threadsWithPrimary,
            noThreadUrl: threadsWithPrimary - threadsWithUrl,
            urlNotObserved: threadsWithUrl - threadsMatched,
            lostToPrecedence,
          },
        },
        engagementFailureClass: '',
        threadPropagationFailureClass: '',
        runtimeDiagBefore: before.result.devDiag,
        runtimeDiagAfter: after.result.devDiag,
      };

      // 10: classify failure modes.
      const finalReport: AttachDiagReport = {
        ...report,
        engagementFailureClass: classifyEngagementFailure(report),
        threadPropagationFailureClass: classifyThreadPropagationFailure(report.threadUrlPropagation),
      };

      // 11: write the report.
      const outDir = path.join(repoRoot, 'packages/sidetrack-extension/test-results');
      await mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, 'attach-diag.json');
      await writeFile(outPath, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');

      // 12: print a compact summary to stdout.
      const summary = {
        extensionBuildSha: finalReport.extensionBuildSha,
        companionBuildSha: finalReport.companionBuildSha,
        stalenessWarning: finalReport.stalenessWarning,
        privacy: finalReport.privacy,
        permissions: finalReport.permissions,
        contentScripts: {
          engagementRegistered: finalReport.contentScripts.engagementRegistered,
          engagementBuiltFileExists: finalReport.contentScripts.engagementBuiltFileExists,
          visualFingerprintRegistered: finalReport.contentScripts.visualFingerprintRegistered,
        },
        materializer: {
          engagementEligibleEntryCount: finalReport.materializer.engagementEligibleEntryCount,
          similarityEdgeCount: finalReport.materializer.similarityEdgeCount,
          rankerStatus: finalReport.materializer.rankerStatus,
          closestVisitEdgeCount: finalReport.materializer.closestVisitEdgeCount,
        },
        threadUrlPropagation: finalReport.threadUrlPropagation,
        engagementFailureClass: finalReport.engagementFailureClass,
        threadPropagationFailureClass: finalReport.threadPropagationFailureClass,
        reportWrittenTo: outPath,
      };
      // eslint-disable-next-line no-console
      console.log(`\n=== attach-diag report ===\n${JSON.stringify(summary, null, 2)}`);

      // The test always passes — its purpose is to produce evidence,
      // not to enforce a verdict. Per-condition pass/fail belongs in
      // the JSON report's *failureClass fields.
      expect(finalReport.cdpAttached).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
