import type { BrowserContext, Page, Response } from '@playwright/test';

import type { ManualEvent, ManualRecorder } from './manualRecorder';
import type { ExtensionRuntime } from './runtime';

export const MANUAL_BROWSER_MODES = [
  'normal-chrome-manual',
  'persistent-playwright-manual',
  'persistent-playwright-stealth-experiment',
  'routed-fixture-e2e',
] as const;

export type ManualBrowserMode = (typeof MANUAL_BROWSER_MODES)[number];

export type ManualNetworkOutcome =
  | 'loaded_live'
  | 'loaded_fixture'
  | 'login_required'
  | 'cloudflare_challenge'
  | 'turnstile_or_captcha'
  | 'http_403'
  | 'navigation_failed';

export interface ManualBrowserModeConfig {
  readonly mode: ManualBrowserMode;
  readonly stealthExperiment: boolean;
  readonly allowedHosts: readonly string[];
}

export interface ManualNetworkClassification {
  readonly outcome: ManualNetworkOutcome;
  readonly reason: string;
  readonly url: string;
  readonly host: string;
  readonly status?: number;
  readonly allowedHost: boolean;
}

export interface ManualExperimentSummary {
  readonly browserMode: ManualBrowserMode;
  readonly browserChannel: string;
  readonly userDataDir: string;
  readonly playwrightAttached: boolean;
  readonly cdpAttached: boolean;
  readonly patchrightLoaded: boolean;
  readonly challengeCountsByHost: Record<string, number>;
  readonly http403CountsByHost: Record<string, number>;
  readonly loginRequiredCountsByHost: Record<string, number>;
  readonly loadedCountsByHost: Record<string, number>;
  readonly capturedPageSnapshots: number;
  readonly replayFixtureSuggested: boolean;
}

interface ManualDocumentResponseLike {
  readonly frame: () => {
    readonly page: () => Page;
  };
}

export const STEALTH_EXPERIMENT_WARNING =
  'Stealth experiment mode is for owned/staging/local diagnostics only. It does not bypass third-party Cloudflare challenges.';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1'] as const;
const STEALTH_MODE: ManualBrowserMode = 'persistent-playwright-stealth-experiment';
const ROUTED_MODE: ManualBrowserMode = 'routed-fixture-e2e';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isManualBrowserMode = (value: string): value is ManualBrowserMode =>
  MANUAL_BROWSER_MODES.some((mode) => mode === value);

export const parseAllowedHosts = (input: string | undefined): readonly string[] => {
  const parsed =
    input
      ?.split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0) ?? [];
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...parsed])];
};

export const resolveManualBrowserMode = (input: {
  readonly requestedMode?: string;
  readonly env?: Record<string, string | undefined>;
  readonly routedFixture?: boolean;
  readonly defaultMode?: ManualBrowserMode;
}): ManualBrowserModeConfig => {
  const env = input.env ?? process.env;
  const rawMode = input.requestedMode ?? env.SIDETRACK_MANUAL_BROWSER_MODE ?? input.defaultMode;
  const mode = rawMode ?? 'persistent-playwright-manual';
  if (!isManualBrowserMode(mode)) {
    throw new Error(
      `Unsupported SIDETRACK_MANUAL_BROWSER_MODE ${mode}; supported: ${MANUAL_BROWSER_MODES.join(
        ', ',
      )}.`,
    );
  }

  if (input.routedFixture === true && mode === STEALTH_MODE) {
    throw new Error('Stealth experiment mode is not allowed in routed-fixture-e2e.');
  }
  if (
    (input.routedFixture === true || mode === ROUTED_MODE) &&
    env.SIDETRACK_E2E_STEALTH_EXPERIMENT === '1'
  ) {
    throw new Error('SIDETRACK_E2E_STEALTH_EXPERIMENT is not allowed in routed-fixture-e2e.');
  }
  if (mode === STEALTH_MODE && env.SIDETRACK_E2E_STEALTH_EXPERIMENT !== '1') {
    throw new Error(
      'persistent-playwright-stealth-experiment requires SIDETRACK_E2E_STEALTH_EXPERIMENT=1.',
    );
  }

  return {
    mode,
    stealthExperiment: mode === STEALTH_MODE,
    allowedHosts: parseAllowedHosts(env.SIDETRACK_STEALTH_ALLOWED_HOSTS),
  };
};

export const assertRoutedFixtureDisallowsStealth = (
  env: Record<string, string | undefined> = process.env,
): void => {
  void resolveManualBrowserMode({
    env,
    routedFixture: true,
    defaultMode: ROUTED_MODE,
  });
};

const hostFor = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const pathFor = (url: string): string => {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
};

const protocolFor = (url: string): string => {
  try {
    return new URL(url).protocol.toLowerCase();
  } catch {
    return '';
  }
};

const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1';

const isFixtureUrl = (url: string, host: string): boolean => {
  const protocol = protocolFor(url);
  return (
    protocol === 'file:' ||
    protocol === 'chrome-extension:' ||
    protocol === 'about:' ||
    isLocalHost(host)
  );
};

const isAllowedHost = (host: string, allowedHosts: readonly string[]): boolean =>
  host.length > 0 &&
  allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));

const hasAny = (input: string, markers: readonly string[]): boolean =>
  markers.some((marker) => input.includes(marker));

export const classifyManualNetworkOutcome = (input: {
  readonly url?: string;
  readonly status?: number;
  readonly title?: string;
  readonly bodyText?: string;
  readonly frameUrls?: readonly string[];
  readonly allowedHosts?: readonly string[];
}): ManualNetworkClassification => {
  const url = input.url ?? '';
  const host = hostFor(url);
  const path = pathFor(url);
  const allowedHosts = input.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const allowedHost = isAllowedHost(host, allowedHosts);
  const lowerTitle = (input.title ?? '').toLowerCase();
  const lowerBody = (input.bodyText ?? '').toLowerCase();
  const lowerFrames = (input.frameUrls ?? []).join('\n').toLowerCase();
  const pageText = `${lowerTitle}\n${lowerBody}\n${lowerFrames}`;

  if (url.length === 0) {
    return {
      outcome: 'navigation_failed',
      reason: 'No URL was available for the navigation.',
      url,
      host,
      allowedHost,
      ...(input.status === undefined ? {} : { status: input.status }),
    };
  }
  if (isFixtureUrl(url, host)) {
    return {
      outcome: 'loaded_fixture',
      reason: 'Local or extension fixture URL loaded.',
      url,
      host,
      allowedHost: true,
      ...(input.status === undefined ? {} : { status: input.status }),
    };
  }
  if (
    host === 'challenges.cloudflare.com' ||
    path.includes('/cdn-cgi/challenge-platform/') ||
    path.includes('/cdn-cgi/challenge') ||
    hasAny(pageText, [
      'challenges.cloudflare.com',
      '/cdn-cgi/challenge-platform/',
      'just a moment',
      'checking your browser',
      'attention required',
      'cloudflare',
    ])
  ) {
    return {
      outcome: 'cloudflare_challenge',
      reason: 'Cloudflare challenge URL, title, body, or iframe marker matched.',
      url,
      host,
      allowedHost,
      ...(input.status === undefined ? {} : { status: input.status }),
    };
  }
  if (
    hasAny(pageText, [
      'turnstile',
      'captcha',
      'verify you are human',
      'prove you are human',
      'human check',
      'are you a human',
    ])
  ) {
    return {
      outcome: 'turnstile_or_captcha',
      reason: 'Turnstile/CAPTCHA/human-check page marker matched.',
      url,
      host,
      allowedHost,
      ...(input.status === undefined ? {} : { status: input.status }),
    };
  }
  if (input.status === 403 && !isFixtureUrl(url, host)) {
    return {
      outcome: 'http_403',
      reason: 'Third-party document returned HTTP 403.',
      url,
      host,
      allowedHost,
      status: input.status,
    };
  }
  if (
    hasAny(pageText, ['sign in', 'sign-in', 'log in', 'login required', 'authenticate']) ||
    path.includes('/login') ||
    path.includes('/signin') ||
    path.includes('/sign-in') ||
    host === 'accounts.google.com'
  ) {
    return {
      outcome: 'login_required',
      reason: 'Login/authentication URL, title, or body marker matched.',
      url,
      host,
      allowedHost,
      ...(input.status === undefined ? {} : { status: input.status }),
    };
  }
  return {
    outcome: 'loaded_live',
    reason: 'Live third-party document loaded without a known challenge marker.',
    url,
    host,
    allowedHost,
    ...(input.status === undefined ? {} : { status: input.status }),
  };
};

const sensitiveHeaderNames = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-bac-bridge-key',
]);

export const redactSensitiveHeaders = (
  headers: Record<string, string | readonly string[] | undefined>,
): Record<string, string | readonly string[] | undefined> => {
  const redacted: Record<string, string | readonly string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    redacted[name] =
      sensitiveHeaderNames.has(lower) || lower.includes('cookie') || lower.includes('token')
        ? '[REDACTED]'
        : value;
  }
  return redacted;
};

const count = (target: Record<string, number>, host: string): void => {
  const key = host.length === 0 ? '<unknown>' : host;
  target[key] = (target[key] ?? 0) + 1;
};

const classificationFromEvent = (event: ManualEvent): ManualNetworkClassification | null => {
  if (event.kind !== 'manual-network-outcome' || !isRecord(event.payload)) return null;
  const outcome = event.payload.outcome;
  const reason = event.payload.reason;
  const url = event.payload.url;
  const host = event.payload.host;
  const allowedHost = event.payload.allowedHost;
  if (
    typeof outcome !== 'string' ||
    typeof reason !== 'string' ||
    typeof url !== 'string' ||
    typeof host !== 'string' ||
    typeof allowedHost !== 'boolean'
  ) {
    return null;
  }
  if (
    ![
      'loaded_live',
      'loaded_fixture',
      'login_required',
      'cloudflare_challenge',
      'turnstile_or_captcha',
      'http_403',
      'navigation_failed',
    ].includes(outcome)
  ) {
    return null;
  }
  const status = typeof event.payload.status === 'number' ? event.payload.status : undefined;
  return {
    outcome: outcome as ManualNetworkOutcome,
    reason,
    url,
    host,
    allowedHost,
    ...(status === undefined ? {} : { status }),
  };
};

export const summarizeManualExperiment = (input: {
  readonly runtime: ExtensionRuntime;
  readonly events: readonly ManualEvent[];
  readonly capturedPageSnapshots: number;
}): ManualExperimentSummary => {
  const challengeCountsByHost: Record<string, number> = {};
  const http403CountsByHost: Record<string, number> = {};
  const loginRequiredCountsByHost: Record<string, number> = {};
  const loadedCountsByHost: Record<string, number> = {};

  for (const event of input.events) {
    const classification = classificationFromEvent(event);
    if (classification === null) continue;
    if (
      classification.outcome === 'cloudflare_challenge' ||
      classification.outcome === 'turnstile_or_captcha'
    ) {
      count(challengeCountsByHost, classification.host);
    } else if (classification.outcome === 'http_403') {
      count(http403CountsByHost, classification.host);
    } else if (classification.outcome === 'login_required') {
      count(loginRequiredCountsByHost, classification.host);
    } else if (
      classification.outcome === 'loaded_live' ||
      classification.outcome === 'loaded_fixture'
    ) {
      count(loadedCountsByHost, classification.host);
    }
  }

  const metadata = input.runtime.metadata;
  return {
    browserMode: metadata?.browserMode ?? 'persistent-playwright-manual',
    browserChannel: metadata?.browserChannel ?? '<unknown>',
    userDataDir: input.runtime.userDataDir,
    playwrightAttached: metadata?.cdpAttached !== true,
    cdpAttached: metadata?.cdpAttached ?? false,
    patchrightLoaded: metadata?.patchrightLoaded ?? false,
    challengeCountsByHost,
    http403CountsByHost,
    loginRequiredCountsByHost,
    loadedCountsByHost,
    capturedPageSnapshots: input.capturedPageSnapshots,
    replayFixtureSuggested:
      Object.keys(challengeCountsByHost).length > 0 || Object.keys(http403CountsByHost).length > 0,
  };
};

export const formatManualExperimentSummary = (summary: ManualExperimentSummary): string => {
  const block = (label: string, values: Record<string, number>): string => {
    const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
    return entries.length === 0
      ? `${label}: none`
      : `${label}:\n${entries.map(([host, value]) => `  - ${host}: ${String(value)}`).join('\n')}`;
  };
  return [
    '================================================================',
    ' SIDETRACK MANUAL BROWSER DIAGNOSTICS',
    '================================================================',
    `browserMode: ${summary.browserMode}`,
    `browserChannel: ${summary.browserChannel}`,
    `userDataDir: ${summary.userDataDir}`,
    `playwrightAttached: ${String(summary.playwrightAttached)}`,
    `cdpAttached: ${String(summary.cdpAttached)}`,
    `patchrightLoaded: ${String(summary.patchrightLoaded)}`,
    block('challengeCountsByHost', summary.challengeCountsByHost),
    block('http403CountsByHost', summary.http403CountsByHost),
    block('loginRequiredCountsByHost', summary.loginRequiredCountsByHost),
    block('loadedCountsByHost', summary.loadedCountsByHost),
    `capturedPageSnapshots: ${String(summary.capturedPageSnapshots)}`,
    `replayFixtureSuggested: ${String(summary.replayFixtureSuggested)}`,
    '================================================================',
  ].join('\n');
};

export const pageFromManualDocumentResponse = (
  response: ManualDocumentResponseLike,
): Page | undefined => {
  try {
    return response.frame().page();
  } catch {
    return undefined;
  }
};

export const installManualNetworkOutcomeRecorder = (
  context: BrowserContext,
  recorder: ManualRecorder,
  options: {
    readonly allowedHosts?: readonly string[];
    readonly logger?: Pick<Console, 'warn'>;
    readonly recordLoadedDocuments?: boolean;
  } = {},
): void => {
  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const logger = options.logger ?? console;
  const notedOutcomes = new Set<string>();

  const maybeLogDetour = (classification: ManualNetworkClassification): void => {
    if (
      classification.outcome !== 'cloudflare_challenge' &&
      classification.outcome !== 'turnstile_or_captcha' &&
      classification.outcome !== 'http_403'
    ) {
      return;
    }
    const noteKey = `${classification.outcome}:${classification.host}`;
    if (notedOutcomes.has(noteKey)) return;
    notedOutcomes.add(noteKey);
    logger.warn(
      `[manual] Challenge detected for ${classification.host || classification.url}. ` +
        'Sidetrack recorded this as a detour; replay should use a local fixture/snapshot.',
    );
  };

  const recordClassification = async (
    page: Page | undefined,
    source: string,
    classification: ManualNetworkClassification,
  ): Promise<void> => {
    if (
      options.recordLoadedDocuments !== true &&
      (classification.outcome === 'loaded_live' || classification.outcome === 'loaded_fixture')
    ) {
      return;
    }
    maybeLogDetour(classification);
    await recorder.record({
      kind: 'manual-network-outcome',
      pageUrl: page?.url() ?? classification.url,
      title: page === undefined ? undefined : await page.title().catch(() => undefined),
      payload: {
        source,
        outcome: classification.outcome,
        reason: classification.reason,
        url: classification.url,
        host: classification.host,
        allowedHost: classification.allowedHost,
        ...(classification.status === undefined ? {} : { status: classification.status }),
      },
    });
  };

  const classifyPage = async (page: Page, source: string): Promise<void> => {
    if (page.isClosed()) return;
    const url = page.url();
    if (url === 'about:blank') return;
    const title = await page.title().catch(() => '');
    const bodyText = await page
      .evaluate(() => document.body.innerText.slice(0, 4000))
      .catch(() => '');
    const classification = classifyManualNetworkOutcome({
      url,
      title,
      bodyText,
      frameUrls: page.frames().map((frame) => frame.url()),
      allowedHosts,
    });
    await recordClassification(page, source, classification);
  };

  const attachPage = (page: Page): void => {
    page.on('domcontentloaded', () => {
      void classifyPage(page, 'domcontentloaded').catch(() => undefined);
    });
  };

  context.on('page', attachPage);
  for (const page of context.pages()) attachPage(page);

  context.on('response', (response: Response) => {
    if (response.request().resourceType() !== 'document') return;
    const page = pageFromManualDocumentResponse(response);
    const classification = classifyManualNetworkOutcome({
      url: response.url(),
      status: response.status(),
      allowedHosts,
    });
    void recordClassification(page, 'document-response', classification).catch(() => undefined);
  });
};
