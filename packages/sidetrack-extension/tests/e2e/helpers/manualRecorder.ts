/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/restrict-template-expressions */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserContext, Frame, Page } from '@playwright/test';

export interface ManualEvent {
  readonly at: string;
  readonly kind: string;
  readonly pageId?: string;
  readonly frameUrl?: string;
  readonly pageUrl?: string;
  readonly title?: string;
  readonly payload?: Record<string, unknown>;
}

export interface ManualHtmlSnapshotTransformInput {
  readonly html: string;
  readonly capturedAt: string;
  readonly pageId: string;
  readonly reason: string;
  readonly url: string;
  readonly title: string;
}

export interface ManualHtmlSnapshotTransformResult {
  readonly html: string;
  readonly redactionCounts?: Record<string, number>;
}

export interface ManualRecorderOptions {
  readonly captureScreenshots?: boolean;
  readonly captureTextSnapshots?: boolean;
  readonly captureHtmlSnapshots?: boolean;
  readonly recordTextValues?: boolean;
  readonly snapshotDelayMs?: number;
  readonly transformHtmlSnapshot?: (
    input: ManualHtmlSnapshotTransformInput,
  ) => Promise<ManualHtmlSnapshotTransformResult> | ManualHtmlSnapshotTransformResult;
}

export interface ManualSnapshotFile {
  readonly capturedAt: string;
  readonly pageId: string;
  readonly reason: string;
  readonly url: string;
  readonly title: string;
  readonly html: string;
  readonly redactionCounts?: Record<string, number>;
}

interface BindingSourceLike {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly frame: Frame;
}

interface SnapshotMeta {
  readonly at: string;
  readonly pageId: string;
  readonly reason: string;
  readonly url: string;
  readonly title: string;
  readonly textPath?: string;
  readonly htmlPath?: string;
  readonly screenshotPath?: string;
  readonly redactionCounts?: Record<string, number>;
}

interface InitScriptOptions {
  readonly recordTextValues: boolean;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    ManualRecorderOptions,
    | 'captureScreenshots'
    | 'captureTextSnapshots'
    | 'captureHtmlSnapshots'
    | 'recordTextValues'
    | 'snapshotDelayMs'
  >
> = {
  captureScreenshots: true,
  captureTextSnapshots: true,
  captureHtmlSnapshots: true,
  recordTextValues: true,
  snapshotDelayMs: 750,
};

const excerpt = (input: unknown, max = 240): string | undefined => {
  if (typeof input !== 'string') return undefined;
  const normalized = input.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeName = (input: string): string => {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return cleaned.length === 0 ? 'page' : cleaned.slice(0, 72);
};

const safeHost = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'page';
  }
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const parseEvents = (raw: string): readonly ManualEvent[] =>
  raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ManualEvent);

const parseSnapshotMeta = (payload: unknown): SnapshotMeta | null => {
  if (!isRecord(payload)) return null;
  const at = payload.at;
  const pageId = payload.pageId;
  const reason = payload.reason;
  const url = payload.url;
  const title = payload.title;
  if (
    typeof at !== 'string' ||
    typeof pageId !== 'string' ||
    typeof reason !== 'string' ||
    typeof url !== 'string' ||
    typeof title !== 'string'
  ) {
    return null;
  }
  const textPath = typeof payload.textPath === 'string' ? payload.textPath : undefined;
  const htmlPath = typeof payload.htmlPath === 'string' ? payload.htmlPath : undefined;
  const screenshotPath =
    typeof payload.screenshotPath === 'string' ? payload.screenshotPath : undefined;
  const redactionCounts = isNumberRecord(payload.redactionCounts)
    ? payload.redactionCounts
    : undefined;
  return {
    at,
    pageId,
    reason,
    url,
    title,
    ...(textPath === undefined ? {} : { textPath }),
    ...(htmlPath === undefined ? {} : { htmlPath }),
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
    ...(redactionCounts === undefined ? {} : { redactionCounts }),
  };
};

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'number');

export class ManualRecorder {
  private readonly context: BrowserContext;
  private readonly artifactsDir: string;
  private readonly eventsPath: string;
  private readonly pagesDir: string;
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly snapshotTimers = new WeakMap<Page, NodeJS.Timeout>();
  private readonly options: Required<
    Pick<
      ManualRecorderOptions,
      | 'captureScreenshots'
      | 'captureTextSnapshots'
      | 'captureHtmlSnapshots'
      | 'recordTextValues'
      | 'snapshotDelayMs'
    >
  > & {
    readonly transformHtmlSnapshot?: ManualRecorderOptions['transformHtmlSnapshot'];
  };
  private nextPageId = 1;

  constructor(context: BrowserContext, artifactsDir: string, options: ManualRecorderOptions = {}) {
    this.context = context;
    this.artifactsDir = artifactsDir;
    this.eventsPath = path.join(artifactsDir, 'events.jsonl');
    this.pagesDir = path.join(artifactsDir, 'pages');
    this.options = {
      captureScreenshots: options.captureScreenshots ?? DEFAULT_OPTIONS.captureScreenshots,
      captureTextSnapshots: options.captureTextSnapshots ?? DEFAULT_OPTIONS.captureTextSnapshots,
      captureHtmlSnapshots: options.captureHtmlSnapshots ?? DEFAULT_OPTIONS.captureHtmlSnapshots,
      recordTextValues: options.recordTextValues ?? DEFAULT_OPTIONS.recordTextValues,
      snapshotDelayMs: options.snapshotDelayMs ?? DEFAULT_OPTIONS.snapshotDelayMs,
      ...(options.transformHtmlSnapshot === undefined
        ? {}
        : { transformHtmlSnapshot: options.transformHtmlSnapshot }),
    };
  }

  async install(): Promise<void> {
    await mkdir(this.pagesDir, { recursive: true });
    await this.context.exposeBinding(
      'sidetrackManualEvent',
      async (source: BindingSourceLike, payload: unknown) => {
        const normalized = isRecord(payload) ? payload : { value: payload };
        await this.record({
          kind: typeof normalized.kind === 'string' ? normalized.kind : 'browser-event',
          pageId: this.pageId(source.page),
          frameUrl: source.frame.url(),
          pageUrl: source.page.url(),
          title: await source.page.title().catch(() => undefined),
          payload: normalized,
        });
        const eventKind = typeof normalized.kind === 'string' ? normalized.kind : '';
        if (
          eventKind === 'click' ||
          eventKind === 'auxclick' ||
          eventKind === 'paste' ||
          eventKind === 'copy' ||
          eventKind === 'input'
        ) {
          this.scheduleSnapshot(source.page, eventKind);
        }
      },
    );
    await this.context.addInitScript(
      (options: InitScriptOptions) => {
        type ManualWindow = Window & {
          sidetrackManualEvent?: (payload: Record<string, unknown>) => Promise<void>;
        };
        const win = window as ManualWindow;
        const normalize = (value: string | null | undefined, max = 240): string | undefined => {
          const text = value?.replace(/\s+/gu, ' ').trim();
          if (text === undefined || text.length === 0) return undefined;
          return text.length > max ? `${text.slice(0, max)}...` : text;
        };
        const cssPath = (element: Element): string => {
          const parts: string[] = [];
          let current: Element | null = element;
          while (current !== null && parts.length < 5) {
            const tag = current.tagName.toLowerCase();
            const id = current.id.length > 0 ? `#${current.id}` : '';
            const cls =
              current.classList.length > 0
                ? `.${Array.from(current.classList).slice(0, 3).join('.')}`
                : '';
            parts.unshift(`${tag}${id}${cls}`);
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const describeTarget = (target: EventTarget | null): Record<string, unknown> => {
          if (!(target instanceof Element)) return {};
          const input = target instanceof HTMLInputElement ? target : null;
          const editable = target.closest('[contenteditable="true"]');
          const anchor = target.closest('a[href]');
          return {
            tagName: target.tagName.toLowerCase(),
            selector: cssPath(target),
            role: target.getAttribute('role') ?? undefined,
            ariaLabel: target.getAttribute('aria-label') ?? undefined,
            href: anchor instanceof HTMLAnchorElement ? anchor.href : undefined,
            text: options.recordTextValues ? normalize(target.textContent) : undefined,
            inputType: input?.type,
            inputName: input?.name,
            inputPlaceholder: input?.placeholder,
            editable: editable !== null,
          };
        };
        const post = (payload: Record<string, unknown>): void => {
          void win
            .sidetrackManualEvent?.({
              ...payload,
              href: window.location.href,
              documentTitle: document.title,
              visibilityState: document.visibilityState,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
            })
            .catch(() => undefined);
        };
        window.addEventListener(
          'click',
          (event) => {
            post({
              kind: 'click',
              button: event.button,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              clientX: event.clientX,
              clientY: event.clientY,
              target: describeTarget(event.target),
            });
          },
          true,
        );
        window.addEventListener(
          'auxclick',
          (event) => {
            post({
              kind: 'auxclick',
              button: event.button,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              clientX: event.clientX,
              clientY: event.clientY,
              target: describeTarget(event.target),
            });
          },
          true,
        );
        window.addEventListener(
          'copy',
          () => {
            const selection = window.getSelection()?.toString() ?? '';
            post({
              kind: 'copy',
              selection: options.recordTextValues ? selection : undefined,
              selectionLength: selection.length,
            });
          },
          true,
        );
        window.addEventListener(
          'paste',
          (event) => {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            post({
              kind: 'paste',
              text: options.recordTextValues ? text : undefined,
              textLength: text.length,
              target: describeTarget(event.target),
            });
          },
          true,
        );
        window.addEventListener(
          'input',
          (event) => {
            const target = event.target;
            let value: string | undefined;
            if (target instanceof HTMLTextAreaElement) value = target.value;
            if (target instanceof HTMLInputElement && target.type !== 'password')
              value = target.value;
            post({
              kind: 'input',
              valueLength: value?.length,
              value: options.recordTextValues ? normalize(value, 400) : undefined,
              target: describeTarget(target),
            });
          },
          true,
        );
        window.addEventListener(
          'focus',
          () => {
            post({ kind: 'window-focus' });
          },
          true,
        );
        window.addEventListener(
          'blur',
          () => {
            post({ kind: 'window-blur' });
          },
          true,
        );
        document.addEventListener('visibilitychange', () => {
          post({ kind: 'visibilitychange', state: document.visibilityState });
        });
        let scrollTimer: number | undefined;
        window.addEventListener(
          'scroll',
          () => {
            if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
            scrollTimer = window.setTimeout(() => {
              post({ kind: 'scroll' });
            }, 350);
          },
          { passive: true, capture: true },
        );
        if (typeof chrome !== 'undefined' && chrome.storage?.onChanged !== undefined) {
          chrome.storage.onChanged.addListener((changes) => {
            const keys = Object.keys(changes).filter((key) => key.startsWith('sidetrack'));
            if (keys.length === 0) return;
            post({
              kind: 'sidetrack-storage-changed',
              keys,
              activeWorkstreamId:
                changes['sidetrack.activeWorkstreamId']?.newValue ??
                changes['sidetrack.activeWorkstreamId']?.oldValue,
            });
          });
        }
      },
      { recordTextValues: this.options.recordTextValues },
    );
    this.context.on('page', (page) => {
      this.attachPage(page);
    });
    for (const page of this.context.pages()) this.attachPage(page);
  }

  async readEvents(): Promise<readonly ManualEvent[]> {
    const raw = await readFile(this.eventsPath, 'utf8').catch(() => '');
    return parseEvents(raw);
  }

  async readSnapshotFiles(): Promise<readonly ManualSnapshotFile[]> {
    const events = await this.readEvents();
    const snapshots: ManualSnapshotFile[] = [];
    for (const event of events) {
      if (event.kind !== 'page-snapshot') continue;
      const meta = parseSnapshotMeta(event.payload);
      if (meta?.htmlPath === undefined) continue;
      const html = await readFile(path.join(this.artifactsDir, meta.htmlPath), 'utf8').catch(
        () => '',
      );
      snapshots.push({
        capturedAt: meta.at,
        pageId: meta.pageId,
        reason: meta.reason,
        url: meta.url,
        title: meta.title,
        html,
        ...(meta.redactionCounts === undefined ? {} : { redactionCounts: meta.redactionCounts }),
      });
    }
    return snapshots;
  }

  private pageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing !== undefined) return existing;
    const id = `p${String(this.nextPageId).padStart(2, '0')}`;
    this.nextPageId += 1;
    this.pageIds.set(page, id);
    return id;
  }

  private attachPage(page: Page): void {
    const pageId = this.pageId(page);
    void this.record({ kind: 'page-opened', pageId, pageUrl: page.url() });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      void this.record({
        kind: 'navigation',
        pageId,
        pageUrl: frame.url(),
        title: undefined,
        payload: { url: frame.url() },
      });
      this.scheduleSnapshot(page, 'navigation');
    });
    page.on('domcontentloaded', () => {
      void this.record({
        kind: 'domcontentloaded',
        pageId,
        pageUrl: page.url(),
      });
      this.scheduleSnapshot(page, 'domcontentloaded');
    });
    page.on('popup', (popup) => {
      void this.record({
        kind: 'popup-opened',
        pageId,
        pageUrl: page.url(),
        payload: { popupPageId: this.pageId(popup), popupUrl: popup.url() },
      });
    });
    page.on('close', () => {
      void this.record({ kind: 'page-closed', pageId, pageUrl: page.url() });
    });
    page.on('console', (message) => {
      void this.record({
        kind: 'console',
        pageId,
        pageUrl: page.url(),
        payload: {
          type: message.type(),
          text: excerpt(message.text(), 800),
          location: message.location(),
        },
      });
    });
  }

  private scheduleSnapshot(page: Page, reason: string): void {
    const existing = this.snapshotTimers.get(page);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.snapshotPage(page, reason).catch((error: unknown) => {
        void this.record({
          kind: 'snapshot-failed',
          pageId: this.pageId(page),
          pageUrl: page.url(),
          payload: { reason, error: error instanceof Error ? error.message : String(error) },
        });
      });
    }, this.options.snapshotDelayMs);
    this.snapshotTimers.set(page, timer);
  }

  async record(event: Omit<ManualEvent, 'at'>): Promise<void> {
    const withTime: ManualEvent = { at: new Date().toISOString(), ...event };
    await appendFile(this.eventsPath, `${JSON.stringify(withTime)}\n`, 'utf8');
  }

  async snapshotPage(page: Page, reason: string): Promise<void> {
    if (page.isClosed()) return;
    const pageId = this.pageId(page);
    const url = page.url();
    if (url === 'about:blank') return;
    const title = await page.title().catch(() => '');
    const capturedAt = new Date().toISOString();
    const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 10);
    const base = `${Date.now()}-${pageId}-${safeName(title || safeHost(url))}-${reason}-${urlHash}`;
    const meta: SnapshotMeta = {
      at: capturedAt,
      pageId,
      reason,
      url,
      title,
      ...(this.options.captureTextSnapshots ? { textPath: `pages/${base}.txt` } : {}),
      ...(this.options.captureHtmlSnapshots ? { htmlPath: `pages/${base}.html` } : {}),
      ...(this.options.captureScreenshots ? { screenshotPath: `pages/${base}.png` } : {}),
    };
    if (this.options.captureTextSnapshots && meta.textPath !== undefined) {
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      await writeFile(path.join(this.artifactsDir, meta.textPath), text.slice(0, 80_000), 'utf8');
    }
    let metaWithRedaction = meta;
    if (this.options.captureHtmlSnapshots && meta.htmlPath !== undefined) {
      const rawHtml = await page.content().catch(() => '');
      const transformed =
        this.options.transformHtmlSnapshot === undefined
          ? { html: rawHtml }
          : await this.options.transformHtmlSnapshot({
              html: rawHtml,
              capturedAt,
              pageId,
              reason,
              url,
              title,
            });
      metaWithRedaction =
        transformed.redactionCounts === undefined
          ? meta
          : { ...meta, redactionCounts: transformed.redactionCounts };
      await writeFile(
        path.join(this.artifactsDir, meta.htmlPath),
        transformed.html.slice(0, 240_000),
        'utf8',
      );
    }
    if (this.options.captureScreenshots && meta.screenshotPath !== undefined) {
      await page
        .screenshot({ path: path.join(this.artifactsDir, meta.screenshotPath), fullPage: false })
        .catch(() => undefined);
    }
    await writeJson(path.join(this.pagesDir, `${base}.json`), metaWithRedaction);
    await this.record({
      kind: 'page-snapshot',
      pageId,
      pageUrl: url,
      title,
      payload: { ...metaWithRedaction },
    });
  }

  async snapshotAll(reason: string): Promise<void> {
    for (const page of this.context.pages()) {
      await this.snapshotPage(page, reason).catch((error: unknown) =>
        this.record({
          kind: 'snapshot-failed',
          pageId: this.pageId(page),
          pageUrl: page.url(),
          payload: { reason, error: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  }

  async writeSummary(): Promise<void> {
    const events = await this.readEvents();
    const navigations = events.filter((event) => event.kind === 'navigation');
    const clicks = events.filter((event) => event.kind === 'click' || event.kind === 'auxclick');
    const copies = events.filter((event) => event.kind === 'copy');
    const pastes = events.filter((event) => event.kind === 'paste');
    const workstreamChanges = events.filter((event) => event.kind === 'sidetrack-storage-changed');
    const lines = [
      '# Sidetrack L5 Manual Recorder Summary',
      '',
      `Artifacts: ${this.artifactsDir}`,
      `Events: ${events.length}`,
      `Navigations: ${navigations.length}`,
      `Clicks: ${clicks.length}`,
      `Copies: ${copies.length}`,
      `Pastes: ${pastes.length}`,
      `Sidetrack storage changes: ${workstreamChanges.length}`,
      '',
      '## Navigations',
      ...navigations
        .slice(-80)
        .map((event) => `- ${event.at} ${event.pageId ?? '?'} ${event.pageUrl ?? ''}`),
      '',
      '## Link Clicks',
      ...clicks.slice(-80).map((event) => {
        const target = isRecord(event.payload?.target) ? event.payload?.target : {};
        return `- ${event.at} ${event.pageId ?? '?'} ${excerpt(target.text) ?? ''} ${typeof target.href === 'string' ? target.href : ''}`;
      }),
      '',
      '## Copy/Paste',
      ...[...copies, ...pastes].slice(-40).map((event) => {
        const text = event.kind === 'copy' ? event.payload?.selection : event.payload?.text;
        return `- ${event.at} ${event.kind} ${event.pageId ?? '?'} ${excerpt(text, 400) ?? ''}`;
      }),
      '',
      '## Workstream Storage Changes',
      ...workstreamChanges
        .slice(-40)
        .map(
          (event) =>
            `- ${event.at} ${event.pageId ?? '?'} active=${String(event.payload?.activeWorkstreamId ?? '')}`,
        ),
      '',
    ];
    await writeFile(
      path.join(this.artifactsDir, 'activity-summary.md'),
      `${lines.join('\n')}\n`,
      'utf8',
    );
  }
}
