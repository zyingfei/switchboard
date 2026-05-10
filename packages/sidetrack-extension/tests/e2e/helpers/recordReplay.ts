/* eslint-disable @typescript-eslint/dot-notation */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { redact } from '../../../../sidetrack-companion/src/safety/redaction';
import { canonicalThreadUrl } from '../../../src/capture/providerDetection';
import { sanitizeTimelineUrl } from '../../../src/timeline/sanitize';
import type { TestCompanion } from './companion';
import type { ManualEvent, ManualSnapshotFile } from './manualRecorder';
import type { ExtensionRuntime } from './runtime';

export const SESSION_PACK_SCHEMA_VERSION = 1;
export const ACTIVE_WORKSTREAM_STORAGE_KEY = 'sidetrack.activeWorkstreamId';
export const TIMELINE_REPLAY_DEBUG_STORAGE_KEY = 'sidetrack.timeline.replayDebug';

export type CaptureLevel = 'minimal' | 'html' | 'html+paste';
export type BrowserLabel = 'A' | 'B';
export type SessionEventTransition = 'activated' | 'updated' | 'closed';

export interface HtmlSnapshot {
  readonly capturedAt: string;
  readonly title: string;
  readonly htmlRedacted: string;
  readonly redactionCounts: Record<string, number>;
}

export type SessionEvent =
  | {
      readonly kind: 'navigation';
      readonly atMs: number;
      readonly tabIdHash: string;
      readonly url: string;
      readonly canonicalUrl: string;
      readonly title: string;
      readonly transition: SessionEventTransition;
      readonly provider?: string;
    }
  | {
      readonly kind: 'tabOpen' | 'tabClose';
      readonly atMs: number;
      readonly tabIdHash: string;
      readonly openerTabIdHash?: string;
    }
  | {
      readonly kind: 'focus' | 'blur';
      readonly atMs: number;
      readonly tabIdHash: string;
    }
  | {
      readonly kind: 'workstreamSwitch';
      readonly atMs: number;
      readonly workstreamId: string;
    }
  | {
      readonly kind: 'copy' | 'paste';
      readonly atMs: number;
      readonly tabIdHash: string;
      readonly contentHash: string;
      readonly length: number;
      readonly content: string;
    }
  | {
      readonly kind: 'dispatch';
      readonly atMs: number;
      readonly dispatchId: string;
      readonly workstreamId: string;
    }
  | {
      readonly kind: 'feedback';
      readonly atMs: number;
      readonly eventType: string;
      readonly payload: unknown;
    };

export interface SessionPackBrowser {
  readonly label: BrowserLabel;
  readonly activeWorkstreamId: string | null;
  readonly events: readonly SessionEvent[];
  readonly snapshots: Record<string, HtmlSnapshot>;
}

export interface SessionPackExpectations {
  readonly expectedCanonicalUrls: readonly string[];
  readonly expectedEdges: readonly {
    readonly kind: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly knownDetours: readonly string[];
}

export interface SessionPack {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly recordedAt: string;
  readonly sidetrackVersion: string;
  readonly mode: {
    readonly browsers: 1 | 2;
    readonly captureLevel: CaptureLevel;
  };
  readonly browsers: readonly SessionPackBrowser[];
  readonly expectations?: SessionPackExpectations;
}

export interface MinimalWorkflowStep {
  readonly url: string;
  readonly title: string;
  readonly provider?: string;
}

export interface WrittenSessionPack {
  readonly packDir: string;
  readonly packPath: string;
}

export interface TimelineItem {
  readonly id: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly visitCount: number;
}

export interface TimelineEnvelope {
  readonly data: {
    readonly items: readonly TimelineItem[];
    readonly entryCount: number;
  };
}

export interface ConnectionsEnvelope {
  readonly data: {
    readonly snapshot: {
      readonly nodes: readonly {
        readonly id: string;
        readonly metadata?: Record<string, unknown>;
      }[];
      readonly edges: readonly {
        readonly kind: string;
        readonly fromNodeId: string;
        readonly toNodeId: string;
        readonly confidence?: string;
        readonly producedBy?: Record<string, unknown>;
        readonly metadata?: Record<string, unknown>;
      }[];
    };
  };
}

export interface RouteStubTracker {
  readonly expectedCanonicalUrls: readonly string[];
  readonly hitCounts: () => ReadonlyMap<string, number>;
  readonly fulfilledBodies: () => ReadonlyMap<string, string>;
  readonly abortedCount: () => number;
}

export interface RouteStubOptions {
  readonly strictOffline?: boolean;
}

interface RouteStub {
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly body?: string;
}

export interface PageReplayResult {
  readonly succeededCanonicalUrls: readonly string[];
  readonly failures: readonly { readonly canonicalUrl: string; readonly reason: string }[];
}

export interface TimelineDrainResult {
  readonly ok: boolean;
  readonly uploaded: number;
  readonly remaining: number;
}

export const timelineReplayDebugEnabled = (): boolean =>
  process.env['SIDETRACK_REPLAY_DEBUG'] === '1';

export const readTimelineReplayDiagnostics = async (
  runtime: ExtensionRuntime,
  senderPage: Page,
): Promise<unknown> =>
  await runtime.sendRuntimeMessage(senderPage, {
    type: 'sidetrack.timeline.diagnostics',
  });

export type ReplayLayerName =
  | 'page-replay'
  | 'extension-observation'
  | 'companion-projection'
  | 'graph-materialization'
  | 'evaluation-expectations';

export interface ReplayLayerReport {
  readonly layer: ReplayLayerName;
  readonly status: 'pass' | 'fail';
  readonly summary: string;
  readonly details: readonly string[];
}

export interface ReplayEvaluationReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly status: 'pass' | 'fail';
  readonly advisoryColor: ScoreColor;
  readonly captureLevel: CaptureLevel;
  readonly scores: GraphQualityScores;
  readonly detours: readonly DetourFinding[];
  readonly detourAssertions: readonly DetourAssertion[];
  readonly qualitativeWarnings: readonly QualitativeWarning[];
  readonly layers: readonly ReplayLayerReport[];
  readonly recordedCanonicalUrls: readonly string[];
  readonly replayedCanonicalUrls: readonly string[];
  readonly timelineCanonicalUrls: readonly string[];
  readonly connectionNodeIds: readonly string[];
  readonly heldUrls?: {
    readonly enabled: boolean;
    readonly reachable: boolean;
    readonly urls: readonly string[];
  };
  readonly strictOffline?: {
    readonly enabled: boolean;
    readonly abortedCount: number;
  };
}

export interface WrittenReplayReport {
  readonly runDir: string;
  readonly markdownPath: string;
  readonly jsonPath: string;
}

export interface ManualRecorderPackInput {
  readonly events: readonly ManualEvent[];
  readonly snapshots: readonly ManualSnapshotFile[];
  readonly label: BrowserLabel;
  readonly activeWorkstreamId: string | null;
}

export type DetourKind =
  | 'cloudflare-challenge'
  | 'login-wall'
  | 'sso-redirect'
  | 'consent-page'
  | 'provider-interstitial'
  | 'not-found-403-404'
  | 'provider-unavailable';

export interface DetourFinding {
  readonly kind: DetourKind;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly reason: string;
}

export type DetourAssertionKind =
  | 'detour-topic-pollution'
  | 'detour-strong-similarity-anchor'
  | 'detour-canonical-preserved'
  | 'detour-listed-in-report';

export interface DetourAssertion {
  readonly kind: DetourAssertionKind;
  readonly status: 'pass' | 'fail';
  readonly summary: string;
  readonly details: readonly string[];
}

export type QualitativeWarningKind =
  | 'many-pages-same-workstream-after-long-idle'
  | 'detour-became-topic-source'
  | 'copy-paste-without-dispatch'
  | 'ambient-page-attached-to-wrong-workstream'
  | 'duplicate-canonical-visit-nodes'
  | 'expected-tab-lineage-missing';

export interface QualitativeWarning {
  readonly kind: QualitativeWarningKind;
  readonly message: string;
  readonly canonicalUrls: readonly string[];
}

export type GraphQualityScoreName =
  | 'topic-purity'
  | 'ambient-containment'
  | 'causal-coherence'
  | 'search-result-chat-continuity'
  | 'false-similarity-rate'
  | 'ranking-plausibility';

export type ScoreColor = 'green' | 'yellow' | 'red';

export interface GraphQualityScore {
  readonly score: number;
  readonly color: ScoreColor;
  readonly rationale: string;
}

export type GraphQualityScores = Record<GraphQualityScoreName, GraphQualityScore>;

export interface ReplayQualityAnalysis {
  readonly advisoryColor: ScoreColor;
  readonly detours: readonly DetourFinding[];
  readonly detourAssertions: readonly DetourAssertion[];
  readonly qualitativeWarnings: readonly QualitativeWarning[];
  readonly scores: GraphQualityScores;
}

interface NavigationRecord {
  readonly browserLabel: BrowserLabel;
  readonly event: Extract<SessionEvent, { readonly kind: 'navigation' }>;
  readonly workstreamId: string | null;
}

interface ClipboardEventRecord {
  readonly browserLabel: BrowserLabel;
  readonly event: Extract<SessionEvent, { readonly kind: 'copy' | 'paste' }>;
}

interface ClipboardPair {
  readonly copy: ClipboardEventRecord;
  readonly paste: ClipboardEventRecord;
}

const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const char32 = (index: number): string => {
  if (index < 0 || index >= CROCKFORD32.length) {
    throw new Error(`Invalid base32 index ${String(index)}.`);
  }
  return CROCKFORD32[index] ?? '';
};

const encodeUlidTime = (timeMs: number): string => {
  let value = BigInt(timeMs);
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = char32(Number(value % 32n)) + out;
    value /= 32n;
  }
  return out;
};

const encodeUlidRandom = (): string => {
  const bytes = randomBytes(10);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      bits -= 5;
      out += char32((buffer >> bits) & 31);
    }
  }
  while (out.length < 16) out += char32(0);
  return out;
};

export const createSessionId = (now = new Date()): string =>
  `ses_${encodeUlidTime(now.getTime())}${encodeUlidRandom()}`;

export const createRunId = (now = new Date()): string =>
  `run_${encodeUlidTime(now.getTime())}${encodeUlidRandom()}`;

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

export const shortHash = (input: string): string => sha256Hex(input).slice(0, 16);

const execFileAsync = async (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    execFile(command, [...args], { cwd }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error('execFile failed.'));
        return;
      }
      resolve(stdout.trim());
    });
  });

export const readSidetrackVersion = async (cwd = process.cwd()): Promise<string> => {
  try {
    const sha = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], cwd);
    return sha.length > 0 ? sha : 'dev';
  } catch {
    return 'dev';
  }
};

export const resolveCaptureLevel = (env: NodeJS.ProcessEnv = process.env): CaptureLevel => {
  const raw = env['SIDETRACK_CAPTURE_LEVEL'] ?? env['SIDETRACK_RECORD_CAPTURE_LEVEL'];
  if (raw === undefined || raw.length === 0) return 'minimal';
  if (raw === 'minimal') return 'minimal';
  if (raw === 'html') return 'html';
  if (raw === 'html+paste') return 'html+paste';
  throw new Error(
    `Unsupported SIDETRACK_CAPTURE_LEVEL ${raw}; supported: minimal, html, html+paste.`,
  );
};

export const resolveTestSessionsDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env['SIDETRACK_TEST_SESSIONS_DIR'];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(homedir(), '.sidetrack', 'test-sessions');
};

export const stripTrailingSlash = (input: string): string => input.replace(/\/+$/u, '');

const canonicalFromEvent = (event: SessionEvent): string | null =>
  event.kind === 'navigation' ? stripTrailingSlash(event.canonicalUrl) : null;

export const recordedCanonicalUrls = (pack: SessionPack): readonly string[] => {
  const urls = new Set<string>();
  for (const browser of pack.browsers) {
    for (const event of browser.events) {
      const canonical = canonicalFromEvent(event);
      if (canonical !== null) urls.add(canonical);
    }
  }
  return [...urls].sort();
};

export const firstBrowser = (pack: SessionPack): SessionPackBrowser => {
  if (pack.browsers.length === 0) {
    throw new Error(`Session pack ${pack.sessionId} has no browsers.`);
  }
  return pack.browsers[0];
};

export const browserByLabel = (pack: SessionPack, label: BrowserLabel): SessionPackBrowser => {
  const browser = pack.browsers.find((candidate) => candidate.label === label);
  if (browser === undefined) {
    throw new Error(`Session pack ${pack.sessionId} has no Browser ${label}.`);
  }
  return browser;
};

export const createMinimalOneBrowserPack = async (input: {
  readonly runtime: ExtensionRuntime;
  readonly workflow: readonly MinimalWorkflowStep[];
  readonly activeWorkstreamId: string | null;
  readonly sidetrackVersion: string;
  readonly sessionId?: string;
}): Promise<SessionPack> => {
  const sessionId = input.sessionId ?? createSessionId();
  const recordedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const events: SessionEvent[] = [];
  if (input.activeWorkstreamId !== null) {
    events.push({
      kind: 'workstreamSwitch',
      atMs: 0,
      workstreamId: input.activeWorkstreamId,
    });
  }

  for (const [index, step] of input.workflow.entries()) {
    const tabIdHash = shortHash(`${sessionId}:A:${String(index)}`);
    const page = await input.runtime.context.newPage();
    events.push({ kind: 'tabOpen', atMs: Date.now() - startedAtMs, tabIdHash });
    events.push({ kind: 'focus', atMs: Date.now() - startedAtMs, tabIdHash });
    await page.goto(step.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    const pageUrl = page.url().length > 0 ? page.url() : step.url;
    const canonicalUrl = stripTrailingSlash(sanitizeTimelineUrl(pageUrl));
    const title = (await page.title().catch(() => step.title)) || step.title;
    events.push({
      kind: 'navigation',
      atMs: Date.now() - startedAtMs,
      tabIdHash,
      url: canonicalUrl,
      canonicalUrl,
      title,
      transition: 'updated',
      ...(step.provider === undefined ? {} : { provider: step.provider }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.close();
    events.push({ kind: 'tabClose', atMs: Date.now() - startedAtMs, tabIdHash });
  }

  const pack: SessionPack = {
    schemaVersion: SESSION_PACK_SCHEMA_VERSION,
    sessionId,
    recordedAt,
    sidetrackVersion: input.sidetrackVersion,
    mode: { browsers: 1, captureLevel: 'minimal' },
    browsers: [
      {
        label: 'A',
        activeWorkstreamId: input.activeWorkstreamId,
        events,
        snapshots: {},
      },
    ],
    expectations: {
      expectedCanonicalUrls: recordedCanonicalUrls({
        schemaVersion: SESSION_PACK_SCHEMA_VERSION,
        sessionId,
        recordedAt,
        sidetrackVersion: input.sidetrackVersion,
        mode: { browsers: 1, captureLevel: 'minimal' },
        browsers: [
          {
            label: 'A',
            activeWorkstreamId: input.activeWorkstreamId,
            events,
            snapshots: {},
          },
        ],
      }),
      expectedEdges: [],
      knownDetours: [],
    },
  };
  assertPackPrivacy(pack);
  return pack;
};

export const redactHtmlForSessionPack = (
  html: string,
): { readonly htmlRedacted: string; readonly redactionCounts: Record<string, number> } => {
  const result = redact(html);
  const redactionCounts: Record<string, number> = {};
  for (const category of result.categories) {
    const marker = `[${category}]`;
    const count = result.output.split(marker).length - 1;
    redactionCounts[category] = count > 0 ? count : result.matched;
  }
  return { htmlRedacted: result.output, redactionCounts };
};

export const createSessionPackFromManualRecorder = (input: {
  readonly browsers: readonly ManualRecorderPackInput[];
  readonly captureLevel: CaptureLevel;
  readonly sidetrackVersion: string;
  readonly sessionId?: string;
  readonly recordedAt?: string;
}): SessionPack => {
  if (input.browsers.length !== 1 && input.browsers.length !== 2) {
    throw new Error('SessionPack conversion expects one or two browsers.');
  }
  const labels = new Set(input.browsers.map((browser) => browser.label));
  if (labels.size !== input.browsers.length) {
    throw new Error('SessionPack browser labels must be unique.');
  }
  const sessionId = input.sessionId ?? createSessionId();
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const browsers = input.browsers.map((browserInput) =>
    convertManualBrowserEvents({
      sessionId,
      captureLevel: input.captureLevel,
      ...browserInput,
    }),
  );
  const pack: SessionPack = {
    schemaVersion: SESSION_PACK_SCHEMA_VERSION,
    sessionId,
    recordedAt,
    sidetrackVersion: input.sidetrackVersion,
    mode: { browsers: input.browsers.length === 1 ? 1 : 2, captureLevel: input.captureLevel },
    browsers,
    expectations: {
      expectedCanonicalUrls: recordedCanonicalUrls({
        schemaVersion: SESSION_PACK_SCHEMA_VERSION,
        sessionId,
        recordedAt,
        sidetrackVersion: input.sidetrackVersion,
        mode: { browsers: input.browsers.length === 1 ? 1 : 2, captureLevel: input.captureLevel },
        browsers,
      }),
      expectedEdges: [],
      knownDetours: [],
    },
  };
  assertPackPrivacy(pack);
  return pack;
};

const convertManualBrowserEvents = (input: {
  readonly sessionId: string;
  readonly captureLevel: CaptureLevel;
  readonly events: readonly ManualEvent[];
  readonly snapshots: readonly ManualSnapshotFile[];
  readonly label: BrowserLabel;
  readonly activeWorkstreamId: string | null;
}): SessionPackBrowser => {
  const sortedEvents = [...input.events].sort((left, right) => isoMs(left.at) - isoMs(right.at));
  const startedAtMs =
    sortedEvents.length === 0
      ? Date.now()
      : Math.min(...sortedEvents.map((event) => isoMs(event.at)));
  const tabHashes = new Map<string, string>();
  const tabHashFor = (pageId: string): string => {
    const existing = tabHashes.get(pageId);
    if (existing !== undefined) return existing;
    const tabHash = shortHash(`${input.sessionId}:${input.label}:${pageId}`);
    tabHashes.set(pageId, tabHash);
    return tabHash;
  };
  const events: SessionEvent[] = [];
  if (input.activeWorkstreamId !== null) {
    events.push({ kind: 'workstreamSwitch', atMs: 0, workstreamId: input.activeWorkstreamId });
  }
  for (const event of sortedEvents) {
    const atMs = Math.max(0, isoMs(event.at) - startedAtMs);
    if (event.kind === 'sidetrack-storage-changed') {
      const workstreamId = event.payload?.['activeWorkstreamId'];
      if (typeof workstreamId === 'string' && workstreamId.length > 0) {
        events.push({ kind: 'workstreamSwitch', atMs, workstreamId });
      }
      continue;
    }
    if (event.pageId === undefined) continue;
    const tabIdHash = tabHashFor(event.pageId);
    if (event.kind === 'page-opened') {
      events.push({ kind: 'tabOpen', atMs, tabIdHash });
      continue;
    }
    if (event.kind === 'page-closed') {
      events.push({ kind: 'tabClose', atMs, tabIdHash });
      continue;
    }
    if (event.kind === 'window-focus') {
      events.push({ kind: 'focus', atMs, tabIdHash });
      continue;
    }
    if (event.kind === 'window-blur') {
      events.push({ kind: 'blur', atMs, tabIdHash });
      continue;
    }
    if ((event.kind === 'copy' || event.kind === 'paste') && input.captureLevel === 'html+paste') {
      const content = manualClipboardContent(event);
      events.push({
        kind: event.kind,
        atMs,
        tabIdHash,
        contentHash: sha256Hex(content),
        length: Buffer.byteLength(content, 'utf8'),
        content,
      });
      continue;
    }
    if (event.kind === 'navigation') {
      const url = manualEventUrl(event);
      if (url === null || !isReplayScopedUrl(url)) continue;
      // Mirror the runtime observer's canonicalization: it applies
      // canonicalThreadUrl to the raw URL, then sanitizeTimelineUrl
      // to the result. Without canonicalThreadUrl here, provider URLs
      // with locale params (e.g. gemini.google.com/app/<id>?hl=en-US)
      // get stored in the pack with the param but get stripped at
      // replay time, producing an "unexpected/missing" mismatch in
      // companion-projection.
      const sanitizedUrl = stripTrailingSlash(sanitizeTimelineUrl(url));
      const canonicalUrl = stripTrailingSlash(sanitizeTimelineUrl(canonicalThreadUrl(url)));
      events.push({
        kind: 'navigation',
        atMs,
        tabIdHash,
        url: sanitizedUrl,
        canonicalUrl,
        title: titleForManualNavigation(event, input.snapshots) ?? canonicalUrl,
        transition: 'updated',
      });
    }
  }
  return {
    label: input.label,
    activeWorkstreamId: input.activeWorkstreamId,
    events,
    snapshots:
      input.captureLevel === 'html' || input.captureLevel === 'html+paste'
        ? snapshotsFromManualFiles(input.snapshots)
        : {},
  };
};

const snapshotsFromManualFiles = (
  snapshots: readonly ManualSnapshotFile[],
): Record<string, HtmlSnapshot> => {
  const output: Record<string, HtmlSnapshot> = {};
  for (const snapshot of snapshots) {
    if (!isReplayScopedUrl(snapshot.url)) continue;
    // Same canonicalization the navigation events use, so pack
    // snapshots and pack events agree on the canonical key.
    const canonicalUrl = stripTrailingSlash(
      sanitizeTimelineUrl(canonicalThreadUrl(snapshot.url)),
    );
    const redacted =
      snapshot.redactionCounts === undefined
        ? redactHtmlForSessionPack(snapshot.html)
        : { htmlRedacted: snapshot.html, redactionCounts: snapshot.redactionCounts };
    output[canonicalUrl] = {
      capturedAt: snapshot.capturedAt,
      title: snapshot.title,
      htmlRedacted: redacted.htmlRedacted,
      redactionCounts: redacted.redactionCounts,
    };
  }
  return output;
};

const titleForManualNavigation = (
  event: ManualEvent,
  snapshots: readonly ManualSnapshotFile[],
): string | null => {
  if (typeof event.title === 'string' && event.title.length > 0) return event.title;
  const url = manualEventUrl(event);
  const samePageSnapshots = snapshots
    .filter(
      (snapshot) =>
        snapshot.pageId === event.pageId &&
        (url === null || stripTrailingSlash(snapshot.url) === stripTrailingSlash(url)),
    )
    .sort((left, right) => isoMs(left.capturedAt) - isoMs(right.capturedAt));
  const latest = samePageSnapshots.at(-1);
  if (latest !== undefined && latest.title.length > 0) return latest.title;
  return null;
};

const manualEventUrl = (event: ManualEvent): string | null => {
  if (typeof event.pageUrl === 'string' && event.pageUrl.length > 0) return event.pageUrl;
  const payloadUrl = event.payload?.['url'];
  return typeof payloadUrl === 'string' && payloadUrl.length > 0 ? payloadUrl : null;
};

const manualClipboardContent = (event: ManualEvent): string => {
  if (event.kind === 'copy') {
    const selection = event.payload?.['selection'];
    return typeof selection === 'string' ? selection : '';
  }
  const text = event.payload?.['text'];
  return typeof text === 'string' ? text : '';
};

const isoMs = (input: string): number => {
  const value = Date.parse(input);
  return Number.isFinite(value) ? value : 0;
};

const comparableStorageStrings = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return value.length >= 8 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => comparableStorageStrings(item));
  if (isRecord(value))
    return Object.values(value).flatMap((item) => comparableStorageStrings(item));
  return [];
};

export const readChromeStorageSnapshot = async (page: Page): Promise<Record<string, unknown>> => {
  const snapshot: unknown = await page.evaluate(async () => await chrome.storage.local.get(null));
  if (!isRecord(snapshot)) {
    throw new Error('chrome.storage.local returned a non-object snapshot.');
  }
  return snapshot;
};

export const assertNoDisallowedStorageValues = (
  pack: SessionPack,
  storageSnapshot: Record<string, unknown>,
): void => {
  const packJson = JSON.stringify(pack);
  for (const [key, value] of Object.entries(storageSnapshot)) {
    if (key === ACTIVE_WORKSTREAM_STORAGE_KEY) continue;
    for (const candidate of comparableStorageStrings(value)) {
      if (packJson.includes(candidate)) {
        throw new Error(
          `Session pack includes chrome.storage.local value from disallowed key ${key}.`,
        );
      }
    }
  }
};

export const assertPackPrivacy = (pack: SessionPack): void => {
  const json = JSON.stringify(pack);
  // The /\blocalStorage\b/ and /\bsessionStorage\b/ rules used to live
  // here but tripped on inline-script API references in real provider
  // HTML (every modern page has `localStorage.setItem(...)` somewhere).
  // The actual privacy boundary for chrome.storage.local *values* is
  // assertNoDisallowedStorageValues, which compares pack JSON against a
  // live chrome.storage.local snapshot. Word-level matches on the API
  // name catch noise, not leaked values, so they are intentionally
  // omitted here.
  const denied: readonly { readonly name: string; readonly pattern: RegExp }[] = [
    { name: 'authorization header', pattern: /\bauthorization\s*:/iu },
    { name: 'bearer token', pattern: /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu },
    { name: 'set-cookie header', pattern: /\bset-cookie\s*:/iu },
    { name: 'cookie header', pattern: /\bcookie\s*[=:]/iu },
    { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u },
    { name: 'OpenAI key', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/u },
  ];
  for (const rule of denied) {
    if (rule.pattern.test(json)) {
      throw new Error(`Session pack privacy deny-list matched ${rule.name}.`);
    }
  }
  for (const browser of pack.browsers) {
    const snapshots = Object.values(browser.snapshots);
    if (pack.mode.captureLevel === 'minimal' && snapshots.length > 0) {
      throw new Error('Minimal packs must not contain HTML snapshots.');
    }
    for (const snapshot of snapshots) {
      if (pack.mode.captureLevel === 'minimal') {
        throw new Error('Minimal packs must not contain HTML snapshots.');
      }
      if (!isNumberRecord(snapshot.redactionCounts)) {
        throw new Error(`HTML snapshot for ${snapshot.title} is missing redactionCounts.`);
      }
    }
    for (const event of browser.events) {
      if (
        (event.kind === 'copy' || event.kind === 'paste') &&
        pack.mode.captureLevel !== 'html+paste'
      ) {
        throw new Error('Only html+paste packs may contain copy/paste content.');
      }
    }
  }
};

export const writeSessionPack = async (
  pack: SessionPack,
  rootDir = resolveTestSessionsDir(),
): Promise<WrittenSessionPack> => {
  assertPackPrivacy(pack);
  const packDir = path.join(rootDir, pack.sessionId);
  await mkdir(packDir, { recursive: true });
  const packPath = path.join(packDir, 'pack.json');
  await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { packDir, packPath };
};

export const readSessionPack = async (packPath: string): Promise<SessionPack> => {
  const raw = await readFile(packPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parseSessionPack(parsed);
};

export const routeKeyFor = (input: string): string => {
  // Normalize trailing slashes so a recorded canonical of /pulls matches
  // a browser-issued request to /pulls/. The recorder's canonical URL
  // pipeline strips trailing slashes; some servers normalise to a slash
  // when issuing redirects. Without this, the route handler reports
  // "stub was not hit" for clean URLs that did navigate during replay.
  const normalize = (pathname: string): string =>
    pathname.length > 1 ? stripTrailingSlash(pathname) : pathname;
  try {
    const url = new URL(input);
    return `${url.origin}${normalize(url.pathname)}`;
  } catch {
    const withoutQuery = input.split('?')[0] ?? input;
    return normalize(withoutQuery);
  }
};

export const installRouteStubsForPack = async (
  context: BrowserContext,
  pack: SessionPack,
  options: RouteStubOptions = {},
): Promise<RouteStubTracker> => {
  const stubs: RouteStub[] = [];
  for (const browser of pack.browsers) {
    for (const event of browser.events) {
      if (event.kind !== 'navigation') continue;
      const canonicalUrl = stripTrailingSlash(event.canonicalUrl);
      const snapshot: HtmlSnapshot | undefined = Object.hasOwn(browser.snapshots, canonicalUrl)
        ? browser.snapshots[canonicalUrl]
        : undefined;
      stubs.push({
        url: event.url,
        canonicalUrl,
        title: event.title,
        ...(snapshot === undefined ? {} : { body: snapshot.htmlRedacted }),
      });
    }
  }
  return await installRouteStubs(context, stubs, options);
};

export const installRouteStubsForWorkflow = async (
  context: BrowserContext,
  workflow: readonly MinimalWorkflowStep[],
  options: RouteStubOptions = {},
): Promise<RouteStubTracker> =>
  await installRouteStubs(
    context,
    workflow.map((step) => {
      const canonicalUrl = stripTrailingSlash(sanitizeTimelineUrl(step.url));
      return {
        url: canonicalUrl,
        canonicalUrl,
        title: step.title,
      };
    }),
    options,
  );

const installRouteStubs = async (
  context: BrowserContext,
  routeStubs: readonly RouteStub[],
  options: RouteStubOptions = {},
): Promise<RouteStubTracker> => {
  const strictOffline = options.strictOffline === true;
  const stubs = new Map<
    string,
    { readonly canonicalUrl: string; readonly title: string; readonly body?: string }
  >();
  for (const stub of routeStubs) {
    stubs.set(routeKeyFor(stub.url), {
      canonicalUrl: stub.canonicalUrl,
      title: stub.title,
      ...(stub.body === undefined ? {} : { body: stub.body }),
    });
  }
  const hits = new Map<string, number>();
  const fulfilledBodies = new Map<string, string>();
  let aborted = 0;
  await context.route(/^https?:\/\//u, async (route) => {
    const rawRequestUrl = route.request().url();
    const requestUrl = sanitizeTimelineUrl(rawRequestUrl);
    const stub = stubs.get(routeKeyFor(requestUrl));
    if (stub === undefined) {
      if (strictOffline) {
        if (isLoopbackHttpUrl(rawRequestUrl)) {
          await route.fallback();
          return;
        }
        aborted += 1;
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
      return;
    }
    hits.set(stub.canonicalUrl, (hits.get(stub.canonicalUrl) ?? 0) + 1);
    const body =
      stub.body ??
      `<!doctype html><title>${escapeHtml(stub.title)}</title><body><h1>${escapeHtml(
        stub.title,
      )}</h1><p>${escapeHtml(stub.canonicalUrl)}</p></body>`;
    fulfilledBodies.set(stub.canonicalUrl, body);
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body,
    });
  });
  return {
    expectedCanonicalUrls: [
      ...new Set([...stubs.values()].map((stub) => stub.canonicalUrl)),
    ].sort(),
    hitCounts: () => new Map(hits),
    fulfilledBodies: () => new Map(fulfilledBodies),
    abortedCount: () => aborted,
  };
};

const isLoopbackHttpUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
};

export interface ReplayTimingOptions {
  // Multiplier applied to recorded `atMs` deltas. 1 = real-time;
  // 0.5 = twice as fast; 2 = half as fast. Default: 1.
  readonly speed?: number;
  // Hard cap on the gap between two consecutive events in replay.
  // Recorded gaps larger than this are compressed to this value.
  // Defaults to 1500ms — long enough for the extension's drain
  // tick to settle, short enough that MV3 service workers don't
  // recycle between events. Set to Infinity to preserve raw timing.
  readonly maxIdleGapMs?: number;
}

const resolveReplayTimingFromEnv = (env: NodeJS.ProcessEnv = process.env): ReplayTimingOptions => {
  const speedRaw = env['SIDETRACK_REPLAY_SPEED'];
  const idleRaw = env['SIDETRACK_REPLAY_MAX_IDLE_MS'];
  const speed =
    speedRaw === undefined || speedRaw.length === 0 ? undefined : Number.parseFloat(speedRaw);
  const maxIdleGapMs =
    idleRaw === undefined || idleRaw.length === 0 ? undefined : Number.parseFloat(idleRaw);
  return {
    ...(speed !== undefined && Number.isFinite(speed) && speed > 0 ? { speed } : {}),
    ...(maxIdleGapMs !== undefined && Number.isFinite(maxIdleGapMs) && maxIdleGapMs >= 0
      ? { maxIdleGapMs }
      : {}),
  };
};

export const computeReplayDelays = (
  events: readonly { readonly atMs: number }[],
  options: ReplayTimingOptions = {},
): readonly number[] => {
  const speed = options.speed === undefined || options.speed <= 0 ? 1 : options.speed;
  const maxIdleGapMs = options.maxIdleGapMs ?? 1500;
  const sorted = [...events].sort((left, right) => left.atMs - right.atMs);
  const delays: number[] = [];
  let previousAtMs = sorted.length > 0 ? sorted[0].atMs : 0;
  let cumulative = 0;
  for (const event of sorted) {
    const recordedGap = Math.max(0, event.atMs - previousAtMs);
    const cappedGap = Math.min(recordedGap, maxIdleGapMs);
    const scaledGap = cappedGap / speed;
    cumulative += scaledGap;
    delays.push(cumulative);
    previousAtMs = event.atMs;
  }
  return delays;
};

export const driveReplayFromPack = async (input: {
  readonly runtime: ExtensionRuntime;
  readonly senderPage: Page;
  readonly pack: SessionPack;
  readonly timing?: ReplayTimingOptions;
}): Promise<PageReplayResult> => {
  return await driveReplayBrowserFromPack({ ...input, label: firstBrowser(input.pack).label });
};

export const driveReplayBrowserFromPack = async (input: {
  readonly runtime: ExtensionRuntime;
  readonly senderPage: Page;
  readonly pack: SessionPack;
  readonly label: BrowserLabel;
  readonly timing?: ReplayTimingOptions;
}): Promise<PageReplayResult> => {
  const browser = browserByLabel(input.pack, input.label);
  if (browser.activeWorkstreamId !== null) {
    await input.runtime.seedStorage(input.senderPage, {
      [ACTIVE_WORKSTREAM_STORAGE_KEY]: browser.activeWorkstreamId,
    });
  }
  const reinitResult = await input.runtime.sendRuntimeMessage(input.senderPage, {
    type: 'sidetrack.timeline.reinit',
  });
  if (!isOkRuntimeResponse(reinitResult)) {
    throw new Error('Timeline observer did not reinitialize before replay.');
  }

  const pages = new Map<string, Page>();
  const succeeded: string[] = [];
  const failures: { canonicalUrl: string; reason: string }[] = [];
  const sortedEvents = [...browser.events].sort((a, b) => a.atMs - b.atMs);
  const timing = input.timing ?? resolveReplayTimingFromEnv();
  const delays = computeReplayDelays(sortedEvents, timing);
  const startedAtMs = Date.now();
  for (const [index, event] of sortedEvents.entries()) {
    const targetMs = delays[index] ?? 0;
    const delayMs = Math.max(0, targetMs - (Date.now() - startedAtMs));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (event.kind === 'workstreamSwitch') {
      await input.runtime.seedStorage(input.senderPage, {
        [ACTIVE_WORKSTREAM_STORAGE_KEY]: event.workstreamId,
      });
      // chrome.storage.onChanged fires async after `set()` resolves;
      // for replays that switch workstreams in rapid succession, the
      // observer's cached workstream id can lag the next page.goto
      // and emit unattributed events. Force a synchronous refresh so
      // the next navigation's emit reads the new workstream id and
      // the companion produces the corresponding visit_in_workstream
      // edge. Best-effort — older builds without the handler return
      // ok:false and we proceed anyway.
      await input.runtime
        .sendRuntimeMessage(input.senderPage, {
          type: 'sidetrack.timeline.refresh-workstream-cache',
        })
        .catch(() => undefined);
      continue;
    }
    if (event.kind === 'tabOpen') {
      // Opening an about:blank tab before the recorded navigation can
      // itself trip the timeline observer. Create the real tab at the
      // navigation event so replayed projection matches the pack.
      continue;
    }
    if (event.kind === 'focus') {
      await pages
        .get(event.tabIdHash)
        ?.bringToFront()
        .catch(() => undefined);
      continue;
    }
    if (event.kind === 'navigation') {
      const page = pages.get(event.tabIdHash) ?? (await input.runtime.context.newPage());
      pages.set(event.tabIdHash, page);
      try {
        await page.goto(event.url, { waitUntil: 'domcontentloaded' });
        succeeded.push(stripTrailingSlash(event.canonicalUrl));
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        failures.push({
          canonicalUrl: stripTrailingSlash(event.canonicalUrl),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (event.kind === 'tabClose') {
      const page = pages.get(event.tabIdHash);
      if (page !== undefined) {
        await page.close().catch(() => undefined);
        pages.delete(event.tabIdHash);
      }
    }
  }
  for (const page of pages.values()) {
    await page.close().catch(() => undefined);
  }
  return {
    succeededCanonicalUrls: [...new Set(succeeded)].sort(),
    failures,
  };
};

export const driveTwoBrowserReplayFromPack = async (input: {
  readonly runtimeA: ExtensionRuntime;
  readonly senderPageA: Page;
  readonly runtimeB: ExtensionRuntime;
  readonly senderPageB: Page;
  readonly pack: SessionPack;
  readonly timing?: ReplayTimingOptions;
}): Promise<PageReplayResult> => {
  const timing = input.timing ?? resolveReplayTimingFromEnv();
  const replayA = await driveReplayBrowserFromPack({
    runtime: input.runtimeA,
    senderPage: input.senderPageA,
    pack: input.pack,
    label: 'A',
    timing,
  });
  const replayB = input.pack.browsers.some((browser) => browser.label === 'B')
    ? await driveReplayBrowserFromPack({
        runtime: input.runtimeB,
        senderPage: input.senderPageB,
        pack: input.pack,
        label: 'B',
        timing,
      })
    : { succeededCanonicalUrls: [], failures: [] };
  return {
    succeededCanonicalUrls: [
      ...new Set([...replayA.succeededCanonicalUrls, ...replayB.succeededCanonicalUrls]),
    ].sort(),
    failures: [...replayA.failures, ...replayB.failures],
  };
};

export const forceDrainTimeline = async (
  runtime: ExtensionRuntime,
  senderPage: Page,
  expectedAtLeast: number,
): Promise<TimelineDrainResult> => {
  let last: TimelineDrainResult = { ok: false, uploaded: 0, remaining: 0 };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await runtime.sendRuntimeMessage(senderPage, {
      type: 'sidetrack.timeline.force-drain',
    });
    const parsed = parseDrainResponse(response);
    if (parsed !== null) {
      last = parsed;
      if (parsed.ok && parsed.uploaded >= expectedAtLeast) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
};

export const companionGet = async (
  companion: TestCompanion,
  requestPath: string,
): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${String(companion.port)}${requestPath}`, {
    headers: { 'x-bac-bridge-key': companion.bridgeKey },
  });
  if (!response.ok) {
    throw new Error(`GET ${requestPath} -> ${String(response.status)}: ${await response.text()}`);
  }
  return await response.json();
};

export const companionPost = async (
  companion: TestCompanion,
  requestPath: string,
  body: unknown,
): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${String(companion.port)}${requestPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bac-bridge-key': companion.bridgeKey,
      'Idempotency-Key': `rr-${createRunId()}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${requestPath} -> ${String(response.status)}: ${await response.text()}`);
  }
  return await response.json();
};

export const readTimeline = async (companion: TestCompanion): Promise<TimelineEnvelope> =>
  parseTimelineEnvelope(await companionGet(companion, '/v1/timeline?limit=1000'));

export const readConnections = async (companion: TestCompanion): Promise<ConnectionsEnvelope> =>
  parseConnectionsEnvelope(await companionGet(companion, '/v1/connections'));

export const waitForReplaySurfaces = async (input: {
  readonly companion: TestCompanion;
  readonly expectedCanonicalUrls: readonly string[];
  readonly activeWorkstreamId: string | null;
  readonly timeoutMs?: number;
}): Promise<{ readonly timeline: TimelineEnvelope; readonly connections: ConnectionsEnvelope }> => {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const startedAtMs = Date.now();
  let lastTimeline = await readTimeline(input.companion);
  let lastConnections = await readConnections(input.companion);
  while (Date.now() - startedAtMs < timeoutMs) {
    lastTimeline = await readTimeline(input.companion);
    lastConnections = await readConnections(input.companion);
    if (
      timelineHasCanonicals(lastTimeline, input.expectedCanonicalUrls) &&
      connectionsHasCanonicals(
        lastConnections,
        input.expectedCanonicalUrls,
        input.activeWorkstreamId,
      )
    ) {
      return { timeline: lastTimeline, connections: lastConnections };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { timeline: lastTimeline, connections: lastConnections };
};

export const classifyDetour = (input: {
  readonly url: string;
  readonly title?: string;
}): DetourFinding | null => {
  const canonicalUrl = stripTrailingSlash(sanitizeTimelineUrl(input.url));
  const url = canonicalUrl.toLowerCase();
  const title = (input.title ?? '').toLowerCase();
  const finding = (kind: DetourKind, reason: string): DetourFinding => ({
    kind,
    canonicalUrl,
    title: input.title ?? canonicalUrl,
    reason,
  });

  if (
    url.includes('/cdn-cgi/challenge') ||
    title.includes('just a moment') ||
    title.includes('attention required') ||
    title.includes('checking your browser') ||
    title.includes('cloudflare')
  ) {
    return finding('cloudflare-challenge', 'Cloudflare challenge URL/title heuristic matched.');
  }
  if (
    url.includes('/sso') ||
    url.includes('saml') ||
    url.includes('openid') ||
    url.includes('oauth') ||
    title.includes('single sign-on') ||
    title.includes('sso redirect')
  ) {
    return finding('sso-redirect', 'SSO/OAuth redirect URL/title heuristic matched.');
  }
  if (
    url.includes('/consent') ||
    url.includes('consent.') ||
    title.includes('consent') ||
    title.includes('before you continue') ||
    title.includes('privacy choices') ||
    title.includes('cookies')
  ) {
    return finding('consent-page', 'Consent/privacy interstitial URL/title heuristic matched.');
  }
  if (
    (url.includes('youtube.com') || url.includes('gemini.google.com')) &&
    (title.includes('sign in') ||
      title.includes('continue') ||
      title.includes('interstitial') ||
      title.includes('age') ||
      title.includes('unusual traffic'))
  ) {
    return finding('provider-interstitial', 'Provider-specific interstitial heuristic matched.');
  }
  if (
    title.includes('404') ||
    title.includes('403') ||
    title.includes('not found') ||
    title.includes('forbidden') ||
    title.includes('access denied') ||
    url.includes('/404') ||
    url.includes('/403')
  ) {
    return finding('not-found-403-404', '403/404/not-found URL/title heuristic matched.');
  }
  if (
    title.includes('service unavailable') ||
    title.includes('temporarily unavailable') ||
    title.includes('over capacity') ||
    title.includes('rate limit') ||
    title.includes('provider unavailable') ||
    url.includes('unavailable') ||
    url.includes('rate-limit')
  ) {
    return finding('provider-unavailable', 'Provider unavailable URL/title heuristic matched.');
  }
  if (
    url.includes('/login') ||
    url.includes('/signin') ||
    url.includes('accounts.') ||
    title.includes('log in') ||
    title.includes('login') ||
    title.includes('sign in') ||
    title.includes('authentication required')
  ) {
    return finding('login-wall', 'Login wall URL/title heuristic matched.');
  }
  return null;
};

export const analyzeReplayQuality = (input: {
  readonly pack: SessionPack;
  readonly timeline: TimelineEnvelope;
  readonly connections: ConnectionsEnvelope;
}): ReplayQualityAnalysis => {
  const navigationRecords = navigationRecordsForPack(input.pack);
  const detours = detoursForNavigationRecords(navigationRecords);
  const detourAssertions = buildDetourAssertions({
    pack: input.pack,
    connections: input.connections,
    navigationRecords,
    detours,
  });
  const qualitativeWarnings = buildQualitativeWarnings({
    pack: input.pack,
    connections: input.connections,
    navigationRecords,
    detours,
  });
  const scores = buildGraphQualityScores({
    pack: input.pack,
    timeline: input.timeline,
    connections: input.connections,
    navigationRecords,
    detours,
  });
  const scoreColors = Object.values(scores).map((score) => score.color);
  const advisoryColor: ScoreColor = scoreColors.includes('red')
    ? 'red'
    : scoreColors.includes('yellow') || qualitativeWarnings.length > 0
      ? 'yellow'
      : 'green';
  return { advisoryColor, detours, detourAssertions, qualitativeWarnings, scores };
};

export const evaluateOneBrowserReplay = (input: {
  readonly pack: SessionPack;
  readonly routeTracker: RouteStubTracker;
  readonly pageReplay: PageReplayResult;
  readonly drain: TimelineDrainResult;
  readonly timeline: TimelineEnvelope;
  readonly connections: ConnectionsEnvelope;
  readonly heldUrls?: readonly string[];
  readonly strictOffline?: boolean;
}): ReplayEvaluationReport => {
  const expectedCanonicals = expectedCanonicalUrls(input.pack);
  const timelineCanonicals = canonicalUrlsFromTimeline(input.timeline);
  const connectionNodeIds = input.connections.data.snapshot.nodes.map((node) => node.id).sort();
  const quality = analyzeReplayQuality({
    pack: input.pack,
    timeline: input.timeline,
    connections: input.connections,
  });
  const hitCounts = input.routeTracker.hitCounts();
  const routeMisses = expectedCanonicals.filter((url) => (hitCounts.get(url) ?? 0) === 0);
  const graphMissingNodes = expectedCanonicals
    .map((url) => `timeline-visit:${url}`)
    .filter((nodeId) => !connectionNodeIds.includes(nodeId));
  const activeWorkstreamId = firstBrowser(input.pack).activeWorkstreamId;
  const graphMissingEdges =
    activeWorkstreamId === null
      ? []
      : expectedCanonicals.filter(
          (url) =>
            !input.connections.data.snapshot.edges.some(
              (edge) =>
                edge.kind === 'visit_in_workstream' &&
                edge.fromNodeId === `timeline-visit:${url}` &&
                edge.toNodeId === `workstream:${activeWorkstreamId}`,
            ),
        );
  const expectedEdges = input.pack.expectations?.expectedEdges ?? [];
  const missingExpectedEdges = expectedEdges.filter(
    (expected) =>
      !input.connections.data.snapshot.edges.some(
        (edge) =>
          edge.kind === expected.kind &&
          edge.fromNodeId === expected.from &&
          edge.toNodeId === expected.to,
      ),
  );
  const failedDetourAssertions = quality.detourAssertions.filter(
    (assertion) => assertion.status === 'fail',
  );

  const layers: ReplayLayerReport[] = [
    layerReport(
      'page-replay',
      routeMisses.length === 0 && input.pageReplay.failures.length === 0,
      `${String(input.pageReplay.succeededCanonicalUrls.length)} navigation(s) replayed through route stubs`,
      [
        ...routeMisses.map((url) => `route stub was not hit for ${url}`),
        ...input.pageReplay.failures.map((failure) => `${failure.canonicalUrl}: ${failure.reason}`),
      ],
    ),
    layerReport(
      'extension-observation',
      input.drain.ok && input.drain.uploaded >= expectedCanonicals.length,
      `force-drain uploaded ${String(input.drain.uploaded)} event(s), remaining ${String(
        input.drain.remaining,
      )}`,
      input.drain.ok ? [] : ['timeline force-drain returned a non-ok response'],
    ),
    layerReport(
      'companion-projection',
      sameStringSet(timelineCanonicals, expectedCanonicals),
      `/v1/timeline returned ${String(timelineCanonicals.length)} canonical URL(s)`,
      diffSets(timelineCanonicals, expectedCanonicals),
    ),
    layerReport(
      'graph-materialization',
      graphMissingNodes.length === 0 && graphMissingEdges.length === 0,
      `/v1/connections exposed ${String(connectionNodeIds.length)} node(s)`,
      [
        ...graphMissingNodes.map((nodeId) => `missing node ${nodeId}`),
        ...graphMissingEdges.map((url) => `missing visit_in_workstream edge for ${url}`),
      ],
    ),
    layerReport(
      'evaluation-expectations',
      missingExpectedEdges.length === 0 &&
        failedDetourAssertions.length === 0 &&
        sameStringSet(
          expectedCanonicalUrls(input.pack),
          input.pack.expectations?.expectedCanonicalUrls ?? expectedCanonicals,
        ),
      'pack expectations matched replay outputs',
      [
        ...missingExpectedEdges.map(
          (edge) => `missing expected edge ${edge.kind} ${edge.from} -> ${edge.to}`,
        ),
        ...failedDetourAssertions.flatMap((assertion) => assertion.details),
      ],
    ),
  ];

  return {
    schemaVersion: SESSION_PACK_SCHEMA_VERSION,
    runId: createRunId(),
    sessionId: input.pack.sessionId,
    generatedAt: new Date().toISOString(),
    status: layers.every((layer) => layer.status === 'pass') ? 'pass' : 'fail',
    advisoryColor: quality.advisoryColor,
    captureLevel: input.pack.mode.captureLevel,
    scores: quality.scores,
    detours: quality.detours,
    detourAssertions: quality.detourAssertions,
    qualitativeWarnings: quality.qualitativeWarnings,
    layers,
    recordedCanonicalUrls: expectedCanonicals,
    replayedCanonicalUrls: input.pageReplay.succeededCanonicalUrls,
    timelineCanonicalUrls: timelineCanonicals,
    connectionNodeIds,
    ...(input.heldUrls === undefined
      ? {}
      : {
          heldUrls: {
            enabled: input.heldUrls.length > 0,
            reachable: input.heldUrls.every((url) => url.length > 0),
            urls: input.heldUrls,
          },
        }),
    ...(input.strictOffline === undefined
      ? {}
      : {
          strictOffline: {
            enabled: input.strictOffline,
            abortedCount: input.routeTracker.abortedCount(),
          },
        }),
  };
};

export const writeReplayReport = async (
  packDir: string,
  report: ReplayEvaluationReport,
  options: { readonly reportDir?: string } = {},
): Promise<WrittenReplayReport> => {
  const runDir =
    options.reportDir === undefined
      ? path.join(packDir, 'runs', report.runId)
      : path.join(options.reportDir, report.runId);
  await mkdir(runDir, { recursive: true });
  const markdownPath = path.join(runDir, 'report.md');
  const jsonPath = path.join(runDir, 'report.json');
  await writeFile(markdownPath, renderReplayMarkdown(report), 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { runDir, markdownPath, jsonPath };
};

export const renderReplayMarkdown = (report: ReplayEvaluationReport): string => {
  const scoreRows = Object.entries(report.scores)
    .map(
      ([name, score]) =>
        `| ${markdownCell(name)} | ${score.score.toFixed(4)} | ${score.color.toUpperCase()} | ${markdownCell(score.rationale)} |`,
    )
    .join('\n');
  const layerRows = report.layers
    .map(
      (layer) =>
        `| ${markdownCell(layer.layer)} | ${layer.status.toUpperCase()} | ${markdownCell(layer.summary)} |`,
    )
    .join('\n');
  const assertionRows = report.detourAssertions
    .map(
      (assertion) =>
        `| ${markdownCell(assertion.kind)} | ${assertion.status.toUpperCase()} | ${markdownCell(assertion.summary)} |`,
    )
    .join('\n');
  const detourRows = report.detours
    .map(
      (detour) =>
        `| ${markdownCell(detour.kind)} | ${markdownCell(detour.canonicalUrl)} | ${markdownCell(detour.reason)} |`,
    )
    .join('\n');
  const warningRows = report.qualitativeWarnings
    .map(
      (warning) =>
        `| ${markdownCell(warning.kind)} | ${markdownCell(warning.message)} | ${markdownCell(warning.canonicalUrls.join(', '))} |`,
    )
    .join('\n');
  const detailBlocks = report.layers
    .filter((layer) => layer.details.length > 0)
    .map(
      (layer) => `### ${layer.layer}\n${layer.details.map((detail) => `- ${detail}`).join('\n')}`,
    )
    .join('\n\n');
  const heldBlock =
    report.heldUrls === undefined
      ? ''
      : `\n\n## Hold URLs\n\n- Reachable: ${report.heldUrls.reachable ? 'yes' : 'no'}\n${report.heldUrls.urls.map((url) => `- ${url}`).join('\n')}`;
  const strictOfflineBlock =
    report.strictOffline === undefined
      ? ''
      : `\n\n## Strict offline replay\n\n- Mode: ${report.strictOffline.enabled ? 'enabled' : 'disabled'}\n- Aborted unstubbed requests: ${String(report.strictOffline.abortedCount)}\n${
          report.strictOffline.enabled
            ? '- All non-recorded URLs were blocked (route.abort) so replay never reached the network.'
            : '- Unstubbed requests were allowed to fall back to the network.'
        }`;
  const detourBlock =
    detourRows.length === 0
      ? '\n\n## Detours\n\nNo detours detected.'
      : `\n\n## Detours\n\n| Kind | Canonical URL | Reason |\n|---|---|---|\n${detourRows}`;
  const warningBlock =
    warningRows.length === 0
      ? '\n\n## Qualitative Warnings\n\nNo qualitative warnings.'
      : `\n\n## Qualitative Warnings\n\n| Warning | Message | Canonical URLs |\n|---|---|---|\n${warningRows}`;
  return `| Score | Value | Color | Rationale |
|---|---:|---|---|
${scoreRows}

# Sidetrack Record/Replay Evaluation

- Session: ${report.sessionId}
- Run: ${report.runId}
- Generated: ${report.generatedAt}
- Overall: ${report.status.toUpperCase()}
- Advisory color: ${report.advisoryColor.toUpperCase()}
- Capture level: ${report.captureLevel}

| Layer | Status | Summary |
|---|---|---|
${layerRows}

## Detour Assertions

| Assertion | Status | Summary |
|---|---|---|
${assertionRows}
${detourBlock}
${warningBlock}

## Recorded Canonical URLs

${report.recordedCanonicalUrls.map((url) => `- ${url}`).join('\n')}

## Timeline Canonical URLs

${report.timelineCanonicalUrls.map((url) => `- ${url}`).join('\n')}
${heldBlock}${strictOfflineBlock}
${detailBlocks.length > 0 ? `\n\n## Details\n\n${detailBlocks}` : ''}
`;
};

const markdownCell = (input: string): string => input.replace(/\s+/gu, ' ').replaceAll('|', '\\|');

const layerReport = (
  layer: ReplayLayerName,
  passed: boolean,
  summary: string,
  details: readonly string[],
): ReplayLayerReport => ({
  layer,
  status: passed ? 'pass' : 'fail',
  summary,
  details,
});

const navigationRecordsForPack = (pack: SessionPack): readonly NavigationRecord[] => {
  const records: NavigationRecord[] = [];
  for (const browser of pack.browsers) {
    let activeWorkstreamId = browser.activeWorkstreamId;
    for (const event of [...browser.events].sort((left, right) => left.atMs - right.atMs)) {
      if (event.kind === 'workstreamSwitch') {
        activeWorkstreamId = event.workstreamId;
        continue;
      }
      if (event.kind === 'navigation') {
        records.push({ browserLabel: browser.label, event, workstreamId: activeWorkstreamId });
      }
    }
  }
  return records;
};

const detoursForNavigationRecords = (
  navigationRecords: readonly NavigationRecord[],
): readonly DetourFinding[] => {
  const byCanonical = new Map<string, DetourFinding>();
  for (const record of navigationRecords) {
    const finding = classifyDetour({
      url: record.event.canonicalUrl,
      title: record.event.title,
    });
    if (finding !== null && !byCanonical.has(finding.canonicalUrl)) {
      byCanonical.set(finding.canonicalUrl, finding);
    }
  }
  return [...byCanonical.values()].sort((left, right) =>
    left.canonicalUrl.localeCompare(right.canonicalUrl),
  );
};

const buildDetourAssertions = (input: {
  readonly pack: SessionPack;
  readonly connections: ConnectionsEnvelope;
  readonly navigationRecords: readonly NavigationRecord[];
  readonly detours: readonly DetourFinding[];
}): readonly DetourAssertion[] => {
  const topicPolluters = input.detours.filter((detour) =>
    isTopicSource(visitNodeId(detour.canonicalUrl), input.connections),
  );
  const strongSimilarityAnchors = input.detours.filter((detour) =>
    isStrongSimilarityAnchor(visitNodeId(detour.canonicalUrl), input.connections),
  );
  const detourCanonicals = new Set(input.detours.map((detour) => detour.canonicalUrl));
  const canonicalReplacementFailures = input.navigationRecords.filter((record) => {
    const canonicalUrl = stripTrailingSlash(record.event.canonicalUrl);
    if (!detourCanonicals.has(canonicalUrl)) return false;
    return !input.navigationRecords.some(
      (candidate) =>
        candidate.browserLabel === record.browserLabel &&
        candidate.event.tabIdHash === record.event.tabIdHash &&
        stripTrailingSlash(candidate.event.canonicalUrl) !== canonicalUrl &&
        !detourCanonicals.has(stripTrailingSlash(candidate.event.canonicalUrl)),
    );
  });
  return [
    detourAssertion(
      'detour-topic-pollution',
      topicPolluters.length === 0,
      'Detours did not become topic sources.',
      topicPolluters.map((detour) => `${detour.kind} polluted topics: ${detour.canonicalUrl}`),
    ),
    detourAssertion(
      'detour-strong-similarity-anchor',
      strongSimilarityAnchors.length === 0,
      'Detours did not become strong similarity anchors.',
      strongSimilarityAnchors.map(
        (detour) => `${detour.kind} was a strong similarity anchor: ${detour.canonicalUrl}`,
      ),
    ),
    detourAssertion(
      'detour-canonical-preserved',
      canonicalReplacementFailures.length === 0,
      'Original target canonical URLs were preserved alongside detours.',
      canonicalReplacementFailures.map(
        (record) =>
          `detour replaced the only recorded target in tab ${record.event.tabIdHash}: ${record.event.canonicalUrl}`,
      ),
    ),
    detourAssertion(
      'detour-listed-in-report',
      true,
      `${String(input.detours.length)} observed detour(s) listed in the report.`,
      [],
    ),
  ];
};

const detourAssertion = (
  kind: DetourAssertionKind,
  passed: boolean,
  summary: string,
  details: readonly string[],
): DetourAssertion => ({ kind, status: passed ? 'pass' : 'fail', summary, details });

const buildQualitativeWarnings = (input: {
  readonly pack: SessionPack;
  readonly connections: ConnectionsEnvelope;
  readonly navigationRecords: readonly NavigationRecord[];
  readonly detours: readonly DetourFinding[];
}): readonly QualitativeWarning[] => {
  const warnings: QualitativeWarning[] = [];
  const longIdle = longIdleWarning(input.navigationRecords);
  if (longIdle !== null) warnings.push(longIdle);
  const topicDetours = input.detours.filter((detour) =>
    isTopicSource(visitNodeId(detour.canonicalUrl), input.connections),
  );
  if (topicDetours.length > 0) {
    warnings.push({
      kind: 'detour-became-topic-source',
      message: 'A Cloudflare/login/detour page became a topic source.',
      canonicalUrls: topicDetours.map((detour) => detour.canonicalUrl),
    });
  }
  const hasClipboard = input.pack.browsers.some((browser) =>
    browser.events.some((event) => event.kind === 'copy' || event.kind === 'paste'),
  );
  if (hasClipboard && !hasDispatchOrCodingEdge(input.pack, input.connections)) {
    warnings.push({
      kind: 'copy-paste-without-dispatch',
      message: 'Copy/paste was observed without a following dispatch or coding-session edge.',
      canonicalUrls: [],
    });
  }
  const ambientAttached = input.navigationRecords.filter((record) => {
    if (!isAmbientVisit(record.event)) return false;
    return graphWorkstreamForNavigation(record, input.connections) !== null;
  });
  if (ambientAttached.length > 0) {
    warnings.push({
      kind: 'ambient-page-attached-to-wrong-workstream',
      message: 'An ambient page was attached to a focused workstream.',
      canonicalUrls: uniqueSorted(ambientAttached.map((record) => record.event.canonicalUrl)),
    });
  }
  const duplicateCanonicals = duplicateCanonicalUrls(input.navigationRecords);
  if (duplicateCanonicals.length > 0) {
    warnings.push({
      kind: 'duplicate-canonical-visit-nodes',
      message: 'A single canonical URL produced multiple visit records.',
      canonicalUrls: duplicateCanonicals,
    });
  }
  const missingLineage = missingTabLineageCanonicals(input.navigationRecords, input.connections);
  if (missingLineage.length > 0) {
    warnings.push({
      kind: 'expected-tab-lineage-missing',
      message: 'Expected same-tab or opener lineage was missing from Connections.',
      canonicalUrls: missingLineage,
    });
  }
  return warnings;
};

const buildGraphQualityScores = (input: {
  readonly pack: SessionPack;
  readonly timeline: TimelineEnvelope;
  readonly connections: ConnectionsEnvelope;
  readonly navigationRecords: readonly NavigationRecord[];
  readonly detours: readonly DetourFinding[];
}): GraphQualityScores => ({
  'topic-purity': topicPurityScore(input.navigationRecords, input.detours, input.connections),
  'ambient-containment': ambientContainmentScore(input.navigationRecords, input.connections),
  'causal-coherence': causalCoherenceScore(input.pack, input.connections),
  'search-result-chat-continuity': searchResultChatContinuityScore(
    input.navigationRecords,
    input.connections,
  ),
  'false-similarity-rate': falseSimilarityRateScore(input.connections),
  'ranking-plausibility': rankingPlausibilityScore(input.connections),
});

const topicPurityScore = (
  navigationRecords: readonly NavigationRecord[],
  detours: readonly DetourFinding[],
  connections: ConnectionsEnvelope,
): GraphQualityScore => {
  const detourCanonicals = new Set(detours.map((detour) => detour.canonicalUrl));
  const topicRecords = navigationRecords.filter(
    (record) => graphWorkstreamForNavigation(record, connections) !== null,
  );
  if (topicRecords.length === 0) {
    return graphScore(1, 'No workstream topic pages were present.');
  }
  const clean = topicRecords.filter((record) => {
    const canonicalUrl = stripTrailingSlash(record.event.canonicalUrl);
    return !detourCanonicals.has(canonicalUrl) && !isAmbientVisit(record.event);
  });
  return graphScore(
    clean.length / topicRecords.length,
    `${String(clean.length)} of ${String(topicRecords.length)} workstream-assigned page(s) were non-detour and non-ambient.`,
  );
};

const ambientContainmentScore = (
  navigationRecords: readonly NavigationRecord[],
  connections: ConnectionsEnvelope,
): GraphQualityScore => {
  const ambient = navigationRecords.filter((record) => isAmbientVisit(record.event));
  if (ambient.length === 0) {
    return graphScore(1, 'No ambient pages were recorded.');
  }
  const contained = ambient.filter(
    (record) => graphWorkstreamForNavigation(record, connections) === null,
  );
  return graphScore(
    contained.length / ambient.length,
    `${String(contained.length)} of ${String(ambient.length)} ambient page(s) were kept out of focused workstreams.`,
  );
};

const causalCoherenceScore = (
  pack: SessionPack,
  connections: ConnectionsEnvelope,
): GraphQualityScore => {
  const pairs = clipboardPairs(pack);
  if (pairs.length === 0) {
    return graphScore(1, 'No copy/paste pairs were recorded.');
  }
  const coherent = pairs.filter((pair) => {
    const source = nearestNavigationForClipboard(pack, pair.copy);
    const destination = nearestNavigationForClipboard(pack, pair.paste);
    if (source === null || destination === null) return false;
    return hasCausalVisitConnection(
      visitNodeId(source.event.canonicalUrl),
      visitNodeId(destination.event.canonicalUrl),
      connections,
    );
  });
  return graphScore(
    coherent.length / pairs.length,
    `${String(coherent.length)} of ${String(pairs.length)} copy/paste pair(s) had a causal graph connection.`,
  );
};

const searchResultChatContinuityScore = (
  navigationRecords: readonly NavigationRecord[],
  connections: ConnectionsEnvelope,
): GraphQualityScore => {
  const triples = searchResultChatTriples(navigationRecords);
  if (triples.length === 0) {
    return graphScore(1, 'No search-result-chat triples were recorded.');
  }
  const connected = triples.filter(
    (triple) =>
      graphHasPath(
        visitNodeId(triple.search.event.canonicalUrl),
        visitNodeId(triple.result.event.canonicalUrl),
        connections,
      ) &&
      graphHasPath(
        visitNodeId(triple.result.event.canonicalUrl),
        visitNodeId(triple.chat.event.canonicalUrl),
        connections,
      ),
  );
  return graphScore(
    connected.length / triples.length,
    `${String(connected.length)} of ${String(triples.length)} search-result-chat triple(s) stayed connected.`,
  );
};

const falseSimilarityRateScore = (connections: ConnectionsEnvelope): GraphQualityScore => {
  const similarityEdges = connections.data.snapshot.edges.filter(
    (edge) => isSimilarityEdgeKind(edge.kind) && edgeScore(edge) >= 0.7,
  );
  if (similarityEdges.length === 0) {
    return graphScore(0, 'No similarity edges were present.', true);
  }
  const falseEdges = similarityEdges.filter((edge) => {
    const left = workstreamForNode(edge.fromNodeId, connections);
    const right = workstreamForNode(edge.toNodeId, connections);
    return left !== null && right !== null && left !== right;
  });
  const rate = falseEdges.length / similarityEdges.length;
  return graphScore(
    rate,
    `${String(falseEdges.length)} of ${String(similarityEdges.length)} strong similarity edge(s) crossed workstreams.`,
    true,
  );
};

const rankingPlausibilityScore = (connections: ConnectionsEnvelope): GraphQualityScore => {
  const rankerEdges = connections.data.snapshot.edges.filter(
    (edge) => edge.kind === 'closest_visit',
  );
  if (rankerEdges.length === 0) {
    return graphScore(1, 'No closest_visit ranker edges were present.');
  }
  const plausible = rankerEdges.filter((edge) => {
    const left = workstreamForNode(edge.fromNodeId, connections);
    const right = workstreamForNode(edge.toNodeId, connections);
    return left !== null && right !== null && left === right;
  });
  return graphScore(
    plausible.length / rankerEdges.length,
    `${String(plausible.length)} of ${String(rankerEdges.length)} ranker candidate(s) shared a workstream with the anchor.`,
  );
};

const graphScore = (raw: number, rationale: string, lowerIsBetter = false): GraphQualityScore => {
  const score = Math.max(0, Math.min(1, Number(raw.toFixed(4))));
  return { score, color: scoreColor(score, lowerIsBetter), rationale };
};

const scoreColor = (score: number, lowerIsBetter: boolean): ScoreColor => {
  if (lowerIsBetter) {
    if (score <= 0.1) return 'green';
    if (score <= 0.25) return 'yellow';
    return 'red';
  }
  if (score >= 0.85) return 'green';
  if (score >= 0.65) return 'yellow';
  return 'red';
};

const longIdleWarning = (
  navigationRecords: readonly NavigationRecord[],
): QualitativeWarning | null => {
  const sorted = [...navigationRecords].sort((left, right) => left.event.atMs - right.event.atMs);
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (current.event.atMs - previous.event.atMs < 30 * 60 * 1000) continue;
    const workstreamId = current.workstreamId;
    if (workstreamId === null) continue;
    const afterIdle = sorted
      .slice(index)
      .filter((record) => record.workstreamId === workstreamId)
      .slice(0, 3);
    if (afterIdle.length >= 3) {
      return {
        kind: 'many-pages-same-workstream-after-long-idle',
        message: 'Many pages were assigned to the same workstream after a long idle gap.',
        canonicalUrls: afterIdle.map((record) => record.event.canonicalUrl),
      };
    }
  }
  return null;
};

const hasDispatchOrCodingEdge = (pack: SessionPack, connections: ConnectionsEnvelope): boolean => {
  if (
    pack.browsers.some((browser) =>
      browser.events.some((event) => event.kind === 'dispatch' || event.kind === 'feedback'),
    )
  ) {
    return true;
  }
  return connections.data.snapshot.edges.some(
    (edge) =>
      edge.kind.includes('dispatch') ||
      edge.kind.includes('coding_session') ||
      edge.kind.includes('snippet'),
  );
};

const duplicateCanonicalUrls = (
  navigationRecords: readonly NavigationRecord[],
): readonly string[] => {
  const counts = new Map<string, Set<string>>();
  for (const record of navigationRecords) {
    const canonicalUrl = stripTrailingSlash(record.event.canonicalUrl);
    const tabIds = counts.get(canonicalUrl) ?? new Set<string>();
    tabIds.add(record.event.tabIdHash);
    counts.set(canonicalUrl, tabIds);
  }
  return [...counts.entries()]
    .filter(([, tabIds]) => tabIds.size > 1)
    .map(([canonicalUrl]) => canonicalUrl)
    .sort();
};

const missingTabLineageCanonicals = (
  navigationRecords: readonly NavigationRecord[],
  connections: ConnectionsEnvelope,
): readonly string[] => {
  const missing: string[] = [];
  const byBrowserTab = new Map<string, NavigationRecord[]>();
  for (const record of navigationRecords) {
    const key = `${record.browserLabel}:${record.event.tabIdHash}`;
    const records = byBrowserTab.get(key) ?? [];
    records.push(record);
    byBrowserTab.set(key, records);
  }
  for (const records of byBrowserTab.values()) {
    const sorted = [...records].sort((left, right) => left.event.atMs - right.event.atMs);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (
        !hasEdgeBetween(
          visitNodeId(previous.event.canonicalUrl),
          visitNodeId(current.event.canonicalUrl),
          connections,
          ['previous_visit_in_tab_session', 'same_tab_navigation', 'opener_visit'],
        )
      ) {
        missing.push(current.event.canonicalUrl);
      }
    }
  }
  return uniqueSorted(missing);
};

const clipboardPairs = (pack: SessionPack): readonly ClipboardPair[] => {
  const copies: ClipboardEventRecord[] = [];
  const pastes: ClipboardEventRecord[] = [];
  for (const browser of pack.browsers) {
    for (const event of browser.events) {
      if (event.kind === 'copy') copies.push({ browserLabel: browser.label, event });
      if (event.kind === 'paste') pastes.push({ browserLabel: browser.label, event });
    }
  }
  const pairs: ClipboardPair[] = [];
  for (const copy of copies) {
    const paste = pastes.find(
      (candidate) =>
        candidate.event.contentHash === copy.event.contentHash &&
        candidate.event.atMs >= copy.event.atMs,
    );
    if (paste !== undefined) pairs.push({ copy, paste });
  }
  return pairs;
};

const nearestNavigationForClipboard = (
  pack: SessionPack,
  clipboard: {
    readonly browserLabel: BrowserLabel;
    readonly event: Extract<SessionEvent, { readonly kind: 'copy' | 'paste' }>;
  },
): NavigationRecord | null => {
  const records = navigationRecordsForPack(pack).filter(
    (record) =>
      record.browserLabel === clipboard.browserLabel &&
      record.event.tabIdHash === clipboard.event.tabIdHash &&
      record.event.atMs <= clipboard.event.atMs,
  );
  return records.sort((left, right) => right.event.atMs - left.event.atMs)[0] ?? null;
};

const searchResultChatTriples = (
  navigationRecords: readonly NavigationRecord[],
): readonly {
  readonly search: NavigationRecord;
  readonly result: NavigationRecord;
  readonly chat: NavigationRecord;
}[] => {
  const sorted = [...navigationRecords].sort((left, right) => left.event.atMs - right.event.atMs);
  const triples: { search: NavigationRecord; result: NavigationRecord; chat: NavigationRecord }[] =
    [];
  for (const search of sorted.filter((record) => isSearchVisit(record.event))) {
    const result = sorted.find(
      (candidate) =>
        candidate.event.atMs > search.event.atMs &&
        candidate.workstreamId === search.workstreamId &&
        !isSearchVisit(candidate.event) &&
        !isChatVisit(candidate.event),
    );
    if (result === undefined) continue;
    const chat = sorted.find(
      (candidate) =>
        candidate.event.atMs > result.event.atMs &&
        candidate.workstreamId === search.workstreamId &&
        isChatVisit(candidate.event),
    );
    if (chat !== undefined) triples.push({ search, result, chat });
  }
  return triples;
};

const isTopicSource = (nodeId: string, connections: ConnectionsEnvelope): boolean => {
  const node = connections.data.snapshot.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.metadata?.['topicSource'] === true) return true;
  return connections.data.snapshot.edges.some(
    (edge) =>
      edge.kind.includes('topic') && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId),
  );
};

const isStrongSimilarityAnchor = (nodeId: string, connections: ConnectionsEnvelope): boolean =>
  connections.data.snapshot.edges.some(
    (edge) =>
      isSimilarityEdgeKind(edge.kind) &&
      (edge.fromNodeId === nodeId || edge.toNodeId === nodeId) &&
      edgeScore(edge) >= 0.7,
  );

const hasCausalVisitConnection = (
  leftNodeId: string,
  rightNodeId: string,
  connections: ConnectionsEnvelope,
): boolean =>
  hasEdgeBetween(leftNodeId, rightNodeId, connections, [
    'previous_visit_in_tab_session',
    'same_tab_navigation',
    'opener_visit',
    'visit_continues_visit',
    'snippet_copied_from_visit',
    'snippet_pasted_into_thread',
    'dispatch_in_workstream',
    'dispatch_requested_coding_session',
    'coding_session_in_workstream',
  ]) || graphHasPath(leftNodeId, rightNodeId, connections);

const graphHasPath = (
  fromNodeId: string,
  toNodeId: string,
  connections: ConnectionsEnvelope,
): boolean => {
  if (fromNodeId === toNodeId) return true;
  const adjacency = new Map<string, Set<string>>();
  for (const edge of connections.data.snapshot.edges) {
    const from = adjacency.get(edge.fromNodeId) ?? new Set<string>();
    from.add(edge.toNodeId);
    adjacency.set(edge.fromNodeId, from);
    const to = adjacency.get(edge.toNodeId) ?? new Set<string>();
    to.add(edge.fromNodeId);
    adjacency.set(edge.toNodeId, to);
  }
  const visited = new Set<string>([fromNodeId]);
  const queue = [fromNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of adjacency.get(current) ?? []) {
      if (next === toNodeId) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
};

const hasEdgeBetween = (
  leftNodeId: string,
  rightNodeId: string,
  connections: ConnectionsEnvelope,
  kinds: readonly string[],
): boolean =>
  connections.data.snapshot.edges.some(
    (edge) =>
      kinds.includes(edge.kind) &&
      ((edge.fromNodeId === leftNodeId && edge.toNodeId === rightNodeId) ||
        (edge.fromNodeId === rightNodeId && edge.toNodeId === leftNodeId)),
  );

const graphWorkstreamForNavigation = (
  record: NavigationRecord,
  connections: ConnectionsEnvelope,
): string | null => workstreamForNode(visitNodeId(record.event.canonicalUrl), connections);

const workstreamForNode = (nodeId: string, connections: ConnectionsEnvelope): string | null => {
  const node = connections.data.snapshot.nodes.find((candidate) => candidate.id === nodeId);
  const metadataWorkstreamId = node?.metadata?.['workstreamId'];
  if (typeof metadataWorkstreamId === 'string' && metadataWorkstreamId.length > 0) {
    return metadataWorkstreamId;
  }
  const edge = connections.data.snapshot.edges.find(
    (candidate) =>
      candidate.kind === 'visit_in_workstream' &&
      candidate.fromNodeId === nodeId &&
      candidate.toNodeId.startsWith('workstream:'),
  );
  return edge === undefined ? null : edge.toNodeId.replace(/^workstream:/u, '');
};

const isSimilarityEdgeKind = (kind: string): boolean =>
  kind === 'visit_resembles_visit' || kind === 'closest_visit';

const edgeScore = (edge: ConnectionsEnvelope['data']['snapshot']['edges'][number]): number => {
  const metadataScore = edge.metadata?.['score'];
  if (typeof metadataScore === 'number') return metadataScore;
  const metadataClosest = edge.metadata?.['closest_visit'];
  if (typeof metadataClosest === 'number') return metadataClosest;
  return edge.kind === 'closest_visit' || edge.kind === 'visit_resembles_visit' ? 1 : 0;
};

const isAmbientVisit = (event: Extract<SessionEvent, { readonly kind: 'navigation' }>): boolean => {
  const haystack = `${event.canonicalUrl} ${event.title}`.toLowerCase();
  return (
    haystack.includes('youtube.com') ||
    haystack.includes('youtu.be') ||
    haystack.includes('spotify.com') ||
    haystack.includes('music') ||
    haystack.includes('soundcloud.com') ||
    haystack.includes('netflix.com') ||
    haystack.includes('twitch.tv')
  );
};

const isSearchVisit = (event: Extract<SessionEvent, { readonly kind: 'navigation' }>): boolean => {
  const haystack = `${event.canonicalUrl} ${event.title}`.toLowerCase();
  return (
    haystack.includes('google.com/search') ||
    haystack.includes('bing.com/search') ||
    haystack.includes('duckduckgo.com') ||
    haystack.includes('search?q=') ||
    haystack.includes(' search ')
  );
};

const isChatVisit = (event: Extract<SessionEvent, { readonly kind: 'navigation' }>): boolean => {
  const haystack = `${event.canonicalUrl} ${event.title}`.toLowerCase();
  return (
    haystack.includes('chatgpt.com') ||
    haystack.includes('claude.ai') ||
    haystack.includes('gemini.google.com') ||
    haystack.includes('coding agent') ||
    haystack.includes('chat thread')
  );
};

const visitNodeId = (canonicalUrl: string): string =>
  `timeline-visit:${stripTrailingSlash(canonicalUrl)}`;

const uniqueSorted = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

const expectedCanonicalUrls = (pack: SessionPack): readonly string[] => {
  const base = pack.expectations?.expectedCanonicalUrls ?? recordedCanonicalUrls(pack);
  const knownDetours = pack.expectations?.knownDetours ?? [];
  return [
    ...new Set(
      base.map(stripTrailingSlash).filter((url) => !matchesKnownDetour(url, knownDetours)),
    ),
  ].sort();
};

const matchesKnownDetour = (url: string, detours: readonly string[]): boolean =>
  detours.some((detour) => url === stripTrailingSlash(detour) || url.includes(detour));

const canonicalUrlsFromTimeline = (timeline: TimelineEnvelope): readonly string[] =>
  [
    ...new Set(
      timeline.data.items
        .map((item) => stripTrailingSlash(item.canonicalUrl ?? item.url))
        .filter(isReplayScopedUrl),
    ),
  ].sort();

const isReplayScopedUrl = (url: string): boolean =>
  url.startsWith('http://') || url.startsWith('https://');

const timelineHasCanonicals = (timeline: TimelineEnvelope, expected: readonly string[]): boolean =>
  sameStringSet(canonicalUrlsFromTimeline(timeline), expected);

const connectionsHasCanonicals = (
  connections: ConnectionsEnvelope,
  expected: readonly string[],
  activeWorkstreamId: string | null,
): boolean => {
  const nodeIds = new Set(connections.data.snapshot.nodes.map((node) => node.id));
  if (!expected.every((url) => nodeIds.has(`timeline-visit:${url}`))) return false;
  if (activeWorkstreamId === null) return true;
  return expected.every((url) =>
    connections.data.snapshot.edges.some(
      (edge) =>
        edge.kind === 'visit_in_workstream' &&
        edge.fromNodeId === `timeline-visit:${url}` &&
        edge.toNodeId === `workstream:${activeWorkstreamId}`,
    ),
  );
};

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

const diffSets = (actual: readonly string[], expected: readonly string[]): readonly string[] => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return [
    ...expected.filter((value) => !actualSet.has(value)).map((value) => `missing ${value}`),
    ...actual.filter((value) => !expectedSet.has(value)).map((value) => `unexpected ${value}`),
  ];
};

const parseDrainResponse = (value: unknown): TimelineDrainResult | null => {
  if (!isRecord(value) || value['ok'] !== true || !isRecord(value['drain'])) return null;
  const uploaded = value['drain']['uploaded'];
  const remaining = value['drain']['remaining'];
  return {
    ok: true,
    uploaded: typeof uploaded === 'number' ? uploaded : 0,
    remaining: typeof remaining === 'number' ? remaining : 0,
  };
};

const isOkRuntimeResponse = (value: unknown): boolean => isRecord(value) && value['ok'] === true;

const parseTimelineEnvelope = (value: unknown): TimelineEnvelope => {
  const data = readRecord(readRecord(value, 'root')['data'], 'data');
  const itemsValue = data['items'];
  if (!Array.isArray(itemsValue)) {
    throw new Error('Timeline response data.items must be an array.');
  }
  const items = itemsValue.map(parseTimelineItem);
  const entryCount = typeof data['entryCount'] === 'number' ? data['entryCount'] : items.length;
  return { data: { items, entryCount } };
};

const parseTimelineItem = (value: unknown): TimelineItem => {
  const record = readRecord(value, 'timeline item');
  const id = readString(record, 'id');
  const url = readString(record, 'url');
  const canonicalUrl = optionalString(record, 'canonicalUrl');
  const title = optionalString(record, 'title');
  const visitCount = typeof record['visitCount'] === 'number' ? record['visitCount'] : 0;
  return {
    id,
    url,
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    ...(title === undefined ? {} : { title }),
    visitCount,
  };
};

const parseConnectionsEnvelope = (value: unknown): ConnectionsEnvelope => {
  const data = readRecord(readRecord(value, 'root')['data'], 'data');
  const snapshot = readRecord(data['snapshot'], 'snapshot');
  const nodeValues = snapshot['nodes'];
  const edgeValues = snapshot['edges'];
  if (!Array.isArray(nodeValues) || !Array.isArray(edgeValues)) {
    throw new Error('Connections response snapshot must include nodes and edges arrays.');
  }
  return {
    data: {
      snapshot: {
        nodes: nodeValues.map((nodeValue) => {
          const node = readRecord(nodeValue, 'connection node');
          const metadata = isRecord(node['metadata']) ? node['metadata'] : undefined;
          return {
            id: readString(node, 'id'),
            ...(metadata === undefined ? {} : { metadata }),
          };
        }),
        edges: edgeValues.map((edgeValue) => {
          const edge = readRecord(edgeValue, 'connection edge');
          const confidence = optionalString(edge, 'confidence');
          const producedBy = isRecord(edge['producedBy']) ? edge['producedBy'] : undefined;
          const metadata = isRecord(edge['metadata']) ? edge['metadata'] : undefined;
          return {
            kind: readString(edge, 'kind'),
            fromNodeId: readString(edge, 'fromNodeId'),
            toNodeId: readString(edge, 'toNodeId'),
            ...(confidence === undefined ? {} : { confidence }),
            ...(producedBy === undefined ? {} : { producedBy }),
            ...(metadata === undefined ? {} : { metadata }),
          };
        }),
      },
    },
  };
};

const parseSessionPack = (value: unknown): SessionPack => {
  const record = readRecord(value, 'SessionPack');
  const schemaVersion = record['schemaVersion'];
  if (schemaVersion !== SESSION_PACK_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported SessionPack schemaVersion ${String(schemaVersion)}; supported: 1.`,
    );
  }
  const mode = readRecord(record['mode'], 'SessionPack.mode');
  const browsersValue = record['browsers'];
  if (!Array.isArray(browsersValue)) {
    throw new Error('SessionPack.browsers must be an array.');
  }
  const expectationsValue = record['expectations'];
  const expectations =
    expectationsValue === undefined ? undefined : parseExpectations(expectationsValue);
  return {
    schemaVersion: SESSION_PACK_SCHEMA_VERSION,
    sessionId: readString(record, 'sessionId'),
    recordedAt: readString(record, 'recordedAt'),
    sidetrackVersion: readString(record, 'sidetrackVersion'),
    mode: {
      browsers: parseBrowserCount(mode['browsers']),
      captureLevel: parseCaptureLevel(mode['captureLevel']),
    },
    browsers: browsersValue.map(parsePackBrowser),
    ...(expectations === undefined ? {} : { expectations }),
  };
};

const parsePackBrowser = (value: unknown): SessionPackBrowser => {
  const record = readRecord(value, 'SessionPackBrowser');
  const label = parseBrowserLabel(record['label']);
  const activeRaw = record['activeWorkstreamId'];
  const activeWorkstreamId =
    activeRaw === null ? null : typeof activeRaw === 'string' ? activeRaw : null;
  const eventsValue = record['events'];
  if (!Array.isArray(eventsValue)) {
    throw new Error('SessionPackBrowser.events must be an array.');
  }
  const snapshotsValue = readRecord(record['snapshots'], 'SessionPackBrowser.snapshots');
  const snapshots: Record<string, HtmlSnapshot> = {};
  for (const [key, snapshot] of Object.entries(snapshotsValue)) {
    snapshots[key] = parseHtmlSnapshot(snapshot);
  }
  return {
    label,
    activeWorkstreamId,
    events: eventsValue.map(parseSessionEvent),
    snapshots,
  };
};

const parseSessionEvent = (value: unknown): SessionEvent => {
  const record = readRecord(value, 'SessionEvent');
  const kind = readString(record, 'kind');
  if (kind === 'navigation') {
    const provider = optionalString(record, 'provider');
    return {
      kind,
      atMs: readNumber(record, 'atMs'),
      tabIdHash: readString(record, 'tabIdHash'),
      url: readString(record, 'url'),
      canonicalUrl: readString(record, 'canonicalUrl'),
      title: readString(record, 'title'),
      transition: parseTransition(record['transition']),
      ...(provider === undefined ? {} : { provider }),
    };
  }
  if (kind === 'tabOpen' || kind === 'tabClose') {
    const openerTabIdHash = optionalString(record, 'openerTabIdHash');
    return {
      kind,
      atMs: readNumber(record, 'atMs'),
      tabIdHash: readString(record, 'tabIdHash'),
      ...(openerTabIdHash === undefined ? {} : { openerTabIdHash }),
    };
  }
  if (kind === 'focus' || kind === 'blur') {
    return { kind, atMs: readNumber(record, 'atMs'), tabIdHash: readString(record, 'tabIdHash') };
  }
  if (kind === 'workstreamSwitch') {
    return {
      kind,
      atMs: readNumber(record, 'atMs'),
      workstreamId: readString(record, 'workstreamId'),
    };
  }
  if (kind === 'copy' || kind === 'paste') {
    return {
      kind,
      atMs: readNumber(record, 'atMs'),
      tabIdHash: readString(record, 'tabIdHash'),
      contentHash: readString(record, 'contentHash'),
      length: readNumber(record, 'length'),
      content: readString(record, 'content'),
    };
  }
  if (kind === 'dispatch') {
    return {
      kind,
      atMs: readNumber(record, 'atMs'),
      dispatchId: readString(record, 'dispatchId'),
      workstreamId: readString(record, 'workstreamId'),
    };
  }
  if (kind === 'feedback') {
    return {
      kind,
      atMs: readNumber(record, 'atMs'),
      eventType: readString(record, 'eventType'),
      payload: record['payload'],
    };
  }
  throw new Error(`Unsupported SessionEvent kind ${kind}.`);
};

const parseHtmlSnapshot = (value: unknown): HtmlSnapshot => {
  const record = readRecord(value, 'HtmlSnapshot');
  const redactionCountsValue = readRecord(
    record['redactionCounts'],
    'HtmlSnapshot.redactionCounts',
  );
  const redactionCounts: Record<string, number> = {};
  for (const [key, count] of Object.entries(redactionCountsValue)) {
    if (typeof count !== 'number') {
      throw new Error(`HtmlSnapshot.redactionCounts.${key} must be a number.`);
    }
    redactionCounts[key] = count;
  }
  return {
    capturedAt: readString(record, 'capturedAt'),
    title: readString(record, 'title'),
    htmlRedacted: readString(record, 'htmlRedacted'),
    redactionCounts,
  };
};

const parseExpectations = (value: unknown): SessionPackExpectations => {
  const record = readRecord(value, 'SessionPack.expectations');
  return {
    expectedCanonicalUrls: readStringArray(record, 'expectedCanonicalUrls'),
    expectedEdges: readEdgeArray(record, 'expectedEdges'),
    knownDetours: readStringArray(record, 'knownDetours'),
  };
};

const readEdgeArray = (
  record: Record<string, unknown>,
  field: string,
): readonly { readonly kind: string; readonly from: string; readonly to: string }[] => {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((item) => {
    const edge = readRecord(item, field);
    return {
      kind: readString(edge, 'kind'),
      from: readString(edge, 'from'),
      to: readString(edge, 'to'),
    };
  });
};

const readStringArray = (record: Record<string, unknown>, field: string): readonly string[] => {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a string array.`);
  }
  return value;
};

const parseBrowserCount = (value: unknown): 1 | 2 => {
  if (value === 1 || value === 2) return value;
  throw new Error(`Unsupported browser count ${String(value)}.`);
};

const parseCaptureLevel = (value: unknown): CaptureLevel => {
  if (value === 'minimal' || value === 'html' || value === 'html+paste') return value;
  throw new Error(`Unsupported captureLevel ${String(value)}.`);
};

const parseBrowserLabel = (value: unknown): BrowserLabel => {
  if (value === 'A' || value === 'B') return value;
  throw new Error(`Unsupported browser label ${String(value)}.`);
};

const parseTransition = (value: unknown): SessionEventTransition => {
  if (value === 'activated' || value === 'updated' || value === 'closed') return value;
  throw new Error(`Unsupported navigation transition ${String(value)}.`);
};

const readRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return value;
};

const readString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
};

const optionalString = (record: Record<string, unknown>, field: string): string | undefined => {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string when present.`);
  return value;
};

const readNumber = (record: Record<string, unknown>, field: string): number => {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'number');

const escapeHtml = (input: string): string =>
  input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
