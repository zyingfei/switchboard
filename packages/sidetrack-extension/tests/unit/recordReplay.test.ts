import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_WORKSTREAM_STORAGE_KEY,
  analyzeReplayQuality,
  assertNoDisallowedStorageValues,
  assertPackPrivacy,
  classifyDetour,
  computeReplayDelays,
  createSessionPackFromManualRecorder,
  createRunId,
  createSessionId,
  evaluateOneBrowserReplay,
  renderReplayMarkdown,
  recordedCanonicalUrls,
  redactHtmlForSessionPack,
  resolveCaptureLevel,
  resolveTestSessionsDir,
  routeKeyFor,
  sha256Hex,
  writeSessionPack,
  type ConnectionsEnvelope,
  type GraphQualityScoreName,
  type RouteStubTracker,
  type SessionEvent,
  type SessionPack,
  type TimelineEnvelope,
} from '../e2e/helpers/recordReplay';

const basePack = (): SessionPack => ({
  schemaVersion: 1,
  sessionId: createSessionId(new Date('2026-05-09T12:00:00.000Z')),
  recordedAt: '2026-05-09T12:00:00.000Z',
  sidetrackVersion: 'test',
  mode: { browsers: 1, captureLevel: 'minimal' },
  browsers: [
    {
      label: 'A',
      activeWorkstreamId: 'ws_t1',
      snapshots: {},
      events: [
        { kind: 'workstreamSwitch', atMs: 0, workstreamId: 'ws_t1' },
        {
          kind: 'navigation',
          atMs: 10,
          tabIdHash: 'tab_hash',
          url: 'https://example.test/a',
          canonicalUrl: 'https://example.test/a',
          title: 'Example',
          transition: 'updated',
          provider: 'generic',
        },
      ],
    },
  ],
  expectations: {
    expectedCanonicalUrls: ['https://example.test/a'],
    expectedEdges: [],
    knownDetours: [],
  },
});

const visitNodeId = (canonicalUrl: string): string => `timeline-visit:${canonicalUrl}`;

const navigation = (
  atMs: number,
  tabIdHash: string,
  canonicalUrl: string,
  title: string,
): Extract<SessionEvent, { readonly kind: 'navigation' }> => ({
  kind: 'navigation',
  atMs,
  tabIdHash,
  url: canonicalUrl,
  canonicalUrl,
  title,
  transition: 'updated',
  provider: 'generic',
});

const timelineFor = (pack: SessionPack): TimelineEnvelope => {
  const urls = recordedCanonicalUrls(pack);
  return {
    data: {
      entryCount: urls.length,
      items: urls.map((url) => ({
        id: visitNodeId(url),
        url,
        canonicalUrl: url,
        title: url,
        visitCount: 1,
      })),
    },
  };
};

const connectionsFor = (
  urls: readonly string[],
  edges: ConnectionsEnvelope['data']['snapshot']['edges'],
  metadata: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): ConnectionsEnvelope => ({
  data: {
    snapshot: {
      nodes: [
        ...urls.map((url) => ({
          id: visitNodeId(url),
          ...(metadata.has(url) ? { metadata: metadata.get(url) } : {}),
        })),
        { id: 'workstream:ws_focus' },
        { id: 'workstream:ws_other' },
        { id: 'workstream:ws_t1' },
      ],
      edges,
    },
  },
});

const stubRouteTracker = (
  urls: readonly string[],
  options: { readonly abortedCount?: number } = {},
): RouteStubTracker => ({
  expectedCanonicalUrls: urls,
  hitCounts: () => new Map(urls.map((url) => [url, 1])),
  fulfilledBodies: () => new Map(),
  abortedCount: () => options.abortedCount ?? 0,
});

const warningPack = (): SessionPack => {
  const raw = 'reusable local snippet';
  return {
    ...basePack(),
    mode: { browsers: 1, captureLevel: 'html+paste' },
    browsers: [
      {
        label: 'A',
        activeWorkstreamId: 'ws_focus',
        snapshots: {},
        events: [
          { kind: 'workstreamSwitch', atMs: 0, workstreamId: 'ws_focus' },
          navigation(0, 'tab_search', 'https://google.com/search?q=sidetrack', 'Sidetrack search'),
          navigation(1_000, 'tab_search', 'https://example.test/result', 'Research result'),
          {
            kind: 'copy',
            atMs: 1_200,
            tabIdHash: 'tab_search',
            contentHash: sha256Hex(raw),
            length: Buffer.byteLength(raw, 'utf8'),
            content: raw,
          },
          navigation(2_000, 'tab_chat', 'https://chatgpt.com/c/warning', 'Chat thread'),
          {
            kind: 'paste',
            atMs: 2_200,
            tabIdHash: 'tab_chat',
            contentHash: sha256Hex(raw),
            length: Buffer.byteLength(raw, 'utf8'),
            content: raw,
          },
          navigation(
            3_000,
            'tab_detour',
            'https://example.test/cdn-cgi/challenge-platform/h/b/orchestrate',
            'Just a moment...',
          ),
          navigation(4_000, 'tab_ambient', 'https://www.youtube.com/watch?v=abc', 'Music mix'),
          navigation(5_000, 'tab_dup_a', 'https://example.test/duplicate', 'Duplicate'),
          navigation(6_000, 'tab_dup_b', 'https://example.test/duplicate', 'Duplicate'),
          navigation(7_000, 'tab_lineage', 'https://example.test/lineage-one', 'Lineage one'),
          navigation(8_000, 'tab_lineage', 'https://example.test/lineage-two', 'Lineage two'),
          navigation(31 * 60 * 1_000, 'tab_idle_1', 'https://example.test/idle-1', 'Idle one'),
          navigation(
            31 * 60 * 1_000 + 1_000,
            'tab_idle_2',
            'https://example.test/idle-2',
            'Idle two',
          ),
          navigation(
            31 * 60 * 1_000 + 2_000,
            'tab_idle_3',
            'https://example.test/idle-3',
            'Idle three',
          ),
        ],
      },
    ],
    expectations: {
      expectedCanonicalUrls: [],
      expectedEdges: [],
      knownDetours: [],
    },
  };
};

const warningConnections = (pack: SessionPack): ConnectionsEnvelope =>
  connectionsFor(recordedCanonicalUrls(pack), [
    {
      kind: 'topic_source_for_workstream',
      fromNodeId: visitNodeId('https://example.test/cdn-cgi/challenge-platform/h/b/orchestrate'),
      toNodeId: 'workstream:ws_focus',
    },
    {
      kind: 'visit_in_workstream',
      fromNodeId: visitNodeId('https://www.youtube.com/watch?v=abc'),
      toNodeId: 'workstream:ws_focus',
    },
  ]);

const scorePack = (): SessionPack => {
  const raw = 'score pack snippet';
  return {
    ...basePack(),
    mode: { browsers: 1, captureLevel: 'html+paste' },
    browsers: [
      {
        label: 'A',
        activeWorkstreamId: 'ws_focus',
        snapshots: {},
        events: [
          { kind: 'workstreamSwitch', atMs: 0, workstreamId: 'ws_focus' },
          navigation(0, 'tab_a', 'https://google.com/search?q=sidetrack', 'Sidetrack search'),
          navigation(1_000, 'tab_a', 'https://example.test/result', 'Research result'),
          {
            kind: 'copy',
            atMs: 1_100,
            tabIdHash: 'tab_a',
            contentHash: sha256Hex(raw),
            length: Buffer.byteLength(raw, 'utf8'),
            content: raw,
          },
          navigation(2_000, 'tab_b', 'https://chatgpt.com/c/score', 'Chat thread'),
          {
            kind: 'paste',
            atMs: 2_100,
            tabIdHash: 'tab_b',
            contentHash: sha256Hex(raw),
            length: Buffer.byteLength(raw, 'utf8'),
            content: raw,
          },
          navigation(3_000, 'tab_c', 'https://accounts.example.test/login', 'Login required'),
          navigation(4_000, 'tab_d', 'https://www.youtube.com/watch?v=ambient', 'Music video'),
          { kind: 'workstreamSwitch', atMs: 5_000, workstreamId: 'ws_other' },
          navigation(5_100, 'tab_e', 'https://example.test/other-work', 'Other work'),
        ],
      },
    ],
    expectations: {
      expectedCanonicalUrls: [],
      expectedEdges: [],
      knownDetours: [],
    },
  };
};

const scoreConnections = (pack: SessionPack): ConnectionsEnvelope => {
  const edge = (
    kind: string,
    from: string,
    to: string,
    metadata?: Record<string, unknown>,
  ): ConnectionsEnvelope['data']['snapshot']['edges'][number] => ({
    kind,
    fromNodeId: visitNodeId(from),
    toNodeId: to.startsWith('workstream:') ? to : visitNodeId(to),
    ...(metadata === undefined ? {} : { metadata }),
  });
  return connectionsFor(recordedCanonicalUrls(pack), [
    edge('visit_in_workstream', 'https://google.com/search?q=sidetrack', 'workstream:ws_focus'),
    edge('visit_in_workstream', 'https://example.test/result', 'workstream:ws_focus'),
    edge('visit_in_workstream', 'https://chatgpt.com/c/score', 'workstream:ws_focus'),
    edge('visit_in_workstream', 'https://accounts.example.test/login', 'workstream:ws_focus'),
    edge('visit_in_workstream', 'https://www.youtube.com/watch?v=ambient', 'workstream:ws_focus'),
    edge('visit_in_workstream', 'https://example.test/other-work', 'workstream:ws_other'),
    edge(
      'same_tab_navigation',
      'https://google.com/search?q=sidetrack',
      'https://example.test/result',
    ),
    edge('snippet_copied_from_visit', 'https://example.test/result', 'https://chatgpt.com/c/score'),
    edge('closest_visit', 'https://google.com/search?q=sidetrack', 'https://example.test/result', {
      score: 0.95,
    }),
    edge('closest_visit', 'https://example.test/result', 'https://example.test/other-work', {
      score: 0.95,
    }),
  ]);
};

describe('T1 record/replay session pack helpers', () => {
  it('defaults captureLevel to minimal and accepts explicit richer capture levels', () => {
    expect(resolveCaptureLevel({})).toBe('minimal');
    expect(resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'minimal' })).toBe('minimal');
    expect(resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'html' })).toBe('html');
    expect(resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'html+paste' })).toBe('html+paste');
  });

  it('uses ~/.sidetrack/test-sessions unless the env override is set', () => {
    expect(resolveTestSessionsDir({ HOME: '/tmp/nope' })).toContain(
      path.join('.sidetrack', 'test-sessions'),
    );
    expect(resolveTestSessionsDir({ SIDETRACK_TEST_SESSIONS_DIR: './test-sessions' })).toBe(
      path.resolve('test-sessions'),
    );
  });

  it('creates schema-shaped ids and SHA-256 hashes', () => {
    expect(createSessionId()).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(createRunId()).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('extracts the recorded canonical URL set deterministically', () => {
    expect(recordedCanonicalUrls(basePack())).toEqual(['https://example.test/a']);
  });

  it('fails privacy checks for disallowed storage values and minimal-only content', () => {
    const pack = basePack();
    expect(() => {
      assertNoDisallowedStorageValues(pack, {
        [ACTIVE_WORKSTREAM_STORAGE_KEY]: 'ws_t1',
        'sidetrack.settings': { bridgeKey: 'bridge_secret_value' },
      });
    }).not.toThrow();

    expect(() => {
      assertNoDisallowedStorageValues(
        {
          ...pack,
          sidetrackVersion: 'bridge_secret_value',
        },
        { 'sidetrack.settings': { bridgeKey: 'bridge_secret_value' } },
      );
    }).toThrow(/disallowed key/u);

    const browser = pack.browsers[0];
    expect(() => {
      assertPackPrivacy({
        ...pack,
        browsers: [
          {
            ...browser,
            events: [
              ...browser.events,
              {
                kind: 'paste',
                atMs: 20,
                tabIdHash: 'tab_hash',
                contentHash: sha256Hex('secret'),
                length: 6,
                content: 'secret',
              },
            ],
          },
        ],
      });
    }).toThrow(/copy\/paste/u);
  });

  it('redacts html snapshots and permits them only for html capture', () => {
    const redacted = redactHtmlForSessionPack(
      `Email owner@example.com and use sk-${'A'.repeat(40)}.`,
    );
    expect(redacted.htmlRedacted).toContain('[email]');
    expect(redacted.htmlRedacted).toContain('[openai-key]');
    expect(redacted.redactionCounts.email).toBe(1);
    expect(redacted.redactionCounts['openai-key']).toBe(1);

    const pack = basePack();
    const browser = pack.browsers[0];
    const htmlPack: SessionPack = {
      ...pack,
      mode: { browsers: 1, captureLevel: 'html' },
      browsers: [
        {
          ...browser,
          snapshots: {
            'https://example.test/a': {
              capturedAt: '2026-05-09T12:00:00.000Z',
              title: 'Example',
              htmlRedacted: redacted.htmlRedacted,
              redactionCounts: redacted.redactionCounts,
            },
          },
        },
      ],
    };
    expect(() => {
      assertPackPrivacy(htmlPack);
    }).not.toThrow();
    expect(() => {
      assertPackPrivacy({
        ...htmlPack,
        mode: { browsers: 1, captureLevel: 'minimal' },
      });
    }).toThrow(/Minimal/u);
  });

  it('converts shared ManualRecorder events and redacted snapshots to SessionPack v1', () => {
    const pack = createSessionPackFromManualRecorder({
      captureLevel: 'html',
      sidetrackVersion: 'test',
      sessionId: 'ses_01HX0000000000000000000000',
      recordedAt: '2026-05-09T12:00:00.000Z',
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: 'ws_t1',
          events: [
            {
              at: '2026-05-09T12:00:00.000Z',
              kind: 'page-opened',
              pageId: 'p01',
              pageUrl: 'about:blank',
            },
            {
              at: '2026-05-09T12:00:00.100Z',
              kind: 'navigation',
              pageId: 'p01',
              pageUrl: 'https://example.test/a?token=secret',
            },
            {
              at: '2026-05-09T12:00:00.200Z',
              kind: 'sidetrack-storage-changed',
              payload: { activeWorkstreamId: 'ws_t1' },
            },
          ],
          snapshots: [
            {
              capturedAt: '2026-05-09T12:00:00.150Z',
              pageId: 'p01',
              reason: 'navigation',
              url: 'https://example.test/a?token=secret',
              title: 'Example',
              html: '<main>owner@example.com</main>',
            },
          ],
        },
        {
          label: 'B',
          activeWorkstreamId: 'ws_t1',
          events: [],
          snapshots: [],
        },
      ],
    });
    expect(pack.mode).toEqual({ browsers: 2, captureLevel: 'html' });
    expect(recordedCanonicalUrls(pack)).toEqual(['https://example.test/a']);
    const snapshot = pack.browsers[0].snapshots['https://example.test/a'];
    expect(snapshot.htmlRedacted).toContain('[email]');
  });

  it('stores raw copy/paste content only at html+paste capture level', () => {
    const raw = 'local paste fragment for replay';
    const sharedEvents = [
      {
        at: '2026-05-09T12:00:00.000Z',
        kind: 'page-opened',
        pageId: 'p01',
        pageUrl: 'about:blank',
      },
      {
        at: '2026-05-09T12:00:00.100Z',
        kind: 'navigation',
        pageId: 'p01',
        pageUrl: 'https://example.test/source',
        title: 'Source',
      },
      {
        at: '2026-05-09T12:00:00.200Z',
        kind: 'copy',
        pageId: 'p01',
        pageUrl: 'https://example.test/source',
        payload: { selection: raw },
      },
      {
        at: '2026-05-09T12:00:00.300Z',
        kind: 'paste',
        pageId: 'p01',
        pageUrl: 'https://example.test/source',
        payload: { text: raw },
      },
    ];

    const pastePack = createSessionPackFromManualRecorder({
      captureLevel: 'html+paste',
      sidetrackVersion: 'test',
      sessionId: 'ses_01HX0000000000000000000001',
      recordedAt: '2026-05-09T12:00:00.000Z',
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: 'ws_t1',
          events: sharedEvents,
          snapshots: [
            {
              capturedAt: '2026-05-09T12:00:00.150Z',
              pageId: 'p01',
              reason: 'navigation',
              url: 'https://example.test/source',
              title: 'Source',
              html: '<main>plain html</main>',
            },
          ],
        },
      ],
    });
    const clipboardEvents = pastePack.browsers[0].events.filter(
      (event) => event.kind === 'copy' || event.kind === 'paste',
    );
    expect(clipboardEvents).toHaveLength(2);
    for (const event of clipboardEvents) {
      if (event.kind !== 'copy' && event.kind !== 'paste') continue;
      expect(event.content).toBe(raw);
      expect(event.contentHash).toBe(sha256Hex(raw));
      expect(event.length).toBe(Buffer.byteLength(raw, 'utf8'));
    }
    expect(() => {
      assertPackPrivacy(pastePack);
    }).not.toThrow();

    const htmlPack = createSessionPackFromManualRecorder({
      captureLevel: 'html',
      sidetrackVersion: 'test',
      sessionId: 'ses_01HX0000000000000000000002',
      recordedAt: '2026-05-09T12:00:00.000Z',
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: 'ws_t1',
          events: sharedEvents,
          snapshots: [],
        },
      ],
    });
    expect(
      htmlPack.browsers[0].events.some((event) => event.kind === 'copy' || event.kind === 'paste'),
    ).toBe(false);
  });

  it('detects every Wave 2c detour kind by URL and title heuristics', () => {
    const examples = [
      {
        kind: 'cloudflare-challenge',
        url: 'https://example.test/cdn-cgi/challenge-platform/h/b/orchestrate',
        title: 'Just a moment...',
      },
      {
        kind: 'login-wall',
        url: 'https://provider.example.test/login',
        title: 'Login required',
      },
      {
        kind: 'sso-redirect',
        url: 'https://idp.example.test/oauth/authorize?client_id=sidetrack',
        title: 'Single sign-on',
      },
      {
        kind: 'consent-page',
        url: 'https://consent.example.test/privacy',
        title: 'Privacy choices',
      },
      {
        kind: 'provider-interstitial',
        url: 'https://www.youtube.com/watch?v=abc',
        title: 'Sign in to confirm your age',
      },
      {
        kind: 'not-found-403-404',
        url: 'https://example.test/missing',
        title: '404 Not Found',
      },
      {
        kind: 'provider-unavailable',
        url: 'https://provider.example.test/unavailable',
        title: 'Service unavailable',
      },
    ] as const;

    for (const example of examples) {
      expect(classifyDetour({ url: example.url, title: example.title })?.kind).toBe(example.kind);
    }
  });

  it('isAmbientVisit checks hostname (not substring) so auth subdomains do not register as ambient', () => {
    // Re-using the spec's basePack helpers via the public analyzer is the
    // fastest way to exercise isAmbientVisit transitively. Build a tiny
    // pack with one ambient URL and one auth-subdomain URL that the old
    // substring check would have false-classified as ambient.
    const buildPack = (canonicalUrl: string, title: string): SessionPack => ({
      ...basePack(),
      mode: { browsers: 1, captureLevel: 'minimal' },
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: 'ws_focus',
          snapshots: {},
          events: [
            { kind: 'workstreamSwitch', atMs: 0, workstreamId: 'ws_focus' },
            navigation(0, 'tab_a', canonicalUrl, title),
          ],
        },
      ],
    });
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ['https://www.youtube.com/watch?v=abc', 'Music mix', true],
      ['https://youtu.be/abc', 'Music mix', true],
      ['https://accounts.youtube.com/accounts/SetSID', 'Sign in', false],
      ['https://music.youtube.com/playlist/abc', 'Music', true],
      ['https://example.test/music-theory-101', 'Music theory 101', true],
      ['https://example.test/page', 'About us', false],
    ];
    for (const [canonicalUrl, title, expected] of cases) {
      const pack = buildPack(canonicalUrl, title);
      const analysis = analyzeReplayQuality({
        pack,
        timeline: timelineFor(pack),
        connections: connectionsFor(recordedCanonicalUrls(pack), [
          {
            kind: 'visit_in_workstream',
            fromNodeId: visitNodeId(canonicalUrl),
            toNodeId: 'workstream:ws_focus',
          },
        ]),
      });
      const ambientWarning = analysis.qualitativeWarnings.find(
        (w) => w.kind === 'ambient-page-attached-to-wrong-workstream',
      );
      expect(ambientWarning !== undefined, `${canonicalUrl} (title: ${title})`).toBe(expected);
    }
  });

  it('does not flag known-provider URLs as cloudflare-challenge purely on title', () => {
    // The L5 recorder captures the page title at navigation time, which
    // may be "Just a moment..." even though the canonical URL is the
    // real provider thread. Without a URL co-signal the classifier was
    // tagging real ChatGPT/Claude/Gemini visits as cloudflare detours.
    const realProviderTitle = 'Just a moment...';
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['https://chatgpt.com/c/abc', realProviderTitle],
      ['https://claude.ai/chat/abc', realProviderTitle],
      ['https://gemini.google.com/app/abc', realProviderTitle],
      ['https://github.com/foo/bar', realProviderTitle],
    ];
    for (const [url, title] of cases) {
      expect(classifyDetour({ url, title })).toBeNull();
    }
    // But the same title on a generic URL (or a URL that carries the
    // cf challenge token in its query) DOES still fire.
    expect(classifyDetour({ url: 'https://example.test/page', title: realProviderTitle })?.kind).toBe(
      'cloudflare-challenge',
    );
    expect(
      classifyDetour({
        url: 'https://chatgpt.com/c/abc?__cf_chl_rt_tk=opaque',
        title: 'ChatGPT — thread',
      })?.kind,
    ).toBe('cloudflare-challenge');
  });

  it('fires each qualitative warning on a constructed pack', () => {
    const pack = warningPack();
    const analysis = analyzeReplayQuality({
      pack,
      timeline: timelineFor(pack),
      connections: warningConnections(pack),
    });
    expect(analysis.qualitativeWarnings.map((warning) => warning.kind).sort()).toEqual([
      'ambient-page-attached-to-wrong-workstream',
      'copy-paste-without-dispatch',
      'detour-became-topic-source',
      'duplicate-canonical-visit-nodes',
      'expected-tab-lineage-missing',
      'many-pages-same-workstream-after-long-idle',
    ]);

    const yellowOnlyPack: SessionPack = {
      ...basePack(),
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: 'ws_focus',
          snapshots: {},
          events: [
            { kind: 'workstreamSwitch', atMs: 0, workstreamId: 'ws_focus' },
            navigation(0, 'tab_a', 'https://example.test/start', 'Start'),
            navigation(31 * 60 * 1_000, 'tab_b', 'https://example.test/idle-a', 'Idle A'),
            navigation(31 * 60 * 1_000 + 1_000, 'tab_c', 'https://example.test/idle-b', 'Idle B'),
            navigation(31 * 60 * 1_000 + 2_000, 'tab_d', 'https://example.test/idle-c', 'Idle C'),
          ],
        },
      ],
    };
    const yellowOnlyAnalysis = analyzeReplayQuality({
      pack: yellowOnlyPack,
      timeline: timelineFor(yellowOnlyPack),
      connections: connectionsFor(recordedCanonicalUrls(yellowOnlyPack), []),
    });
    expect(yellowOnlyAnalysis.qualitativeWarnings.map((warning) => warning.kind)).toEqual([
      'many-pages-same-workstream-after-long-idle',
    ]);
    expect(yellowOnlyAnalysis.advisoryColor).toBe('yellow');
  });

  it('returns stable 0-1 graph-quality scores with rationale strings', () => {
    const pack = scorePack();
    const analysis = analyzeReplayQuality({
      pack,
      timeline: timelineFor(pack),
      connections: scoreConnections(pack),
    });
    const expectedScoreNames: readonly GraphQualityScoreName[] = [
      'topic-purity',
      'ambient-containment',
      'causal-coherence',
      'search-result-chat-continuity',
      'false-similarity-rate',
      'ranking-plausibility',
    ];
    expect(Object.keys(analysis.scores).sort()).toEqual([...expectedScoreNames].sort());
    for (const name of expectedScoreNames) {
      expect(analysis.scores[name].score).toBeGreaterThanOrEqual(0);
      expect(analysis.scores[name].score).toBeLessThanOrEqual(1);
      expect(analysis.scores[name].rationale.length).toBeGreaterThan(0);
    }
    expect(analysis.scores['topic-purity'].score).toBe(0.6667);
    expect(analysis.scores['ambient-containment'].score).toBe(0);
    expect(analysis.scores['causal-coherence'].score).toBe(1);
    expect(analysis.scores['search-result-chat-continuity'].score).toBe(1);
    expect(analysis.scores['false-similarity-rate'].score).toBe(0.5);
    expect(analysis.scores['ranking-plausibility'].score).toBe(0.5);
  });

  it('opens markdown reports with the score table and keeps scores stable in JSON', () => {
    const pack = basePack();
    const urls = recordedCanonicalUrls(pack);
    const connections = connectionsFor(urls, [
      {
        kind: 'visit_in_workstream',
        fromNodeId: visitNodeId('https://example.test/a'),
        toNodeId: 'workstream:ws_t1',
      },
    ]);
    const report = evaluateOneBrowserReplay({
      pack,
      routeTracker: stubRouteTracker(urls),
      pageReplay: { succeededCanonicalUrls: urls, failures: [] },
      drain: { ok: true, uploaded: urls.length, remaining: 0 },
      timeline: timelineFor(pack),
      connections,
    });
    const repeatedReport = evaluateOneBrowserReplay({
      pack,
      routeTracker: stubRouteTracker(urls),
      pageReplay: { succeededCanonicalUrls: urls, failures: [] },
      drain: { ok: true, uploaded: urls.length, remaining: 0 },
      timeline: timelineFor(pack),
      connections,
    });
    const markdown = renderReplayMarkdown(report);
    expect(markdown.startsWith('| Score | Value | Color | Rationale |')).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toHaveProperty('scores');
    expect(repeatedReport.scores).toEqual(report.scores);
  });

  it('surfaces strict-offline state and aborted-request count in the report and markdown', () => {
    const pack = basePack();
    const urls = recordedCanonicalUrls(pack);
    const connections = connectionsFor(urls, [
      {
        kind: 'visit_in_workstream',
        fromNodeId: visitNodeId('https://example.test/a'),
        toNodeId: 'workstream:ws_t1',
      },
    ]);
    const baseInput = {
      pack,
      pageReplay: { succeededCanonicalUrls: urls, failures: [] },
      drain: { ok: true, uploaded: urls.length, remaining: 0 },
      timeline: timelineFor(pack),
      connections,
    } as const;

    const offReport = evaluateOneBrowserReplay({
      ...baseInput,
      routeTracker: stubRouteTracker(urls, { abortedCount: 0 }),
    });
    expect(offReport.strictOffline).toBeUndefined();

    const onReport = evaluateOneBrowserReplay({
      ...baseInput,
      routeTracker: stubRouteTracker(urls, { abortedCount: 17 }),
      strictOffline: true,
    });
    expect(onReport.strictOffline).toEqual({ enabled: true, abortedCount: 17 });

    const disabledReport = evaluateOneBrowserReplay({
      ...baseInput,
      routeTracker: stubRouteTracker(urls, { abortedCount: 0 }),
      strictOffline: false,
    });
    expect(disabledReport.strictOffline).toEqual({ enabled: false, abortedCount: 0 });

    const markdown = renderReplayMarkdown(onReport);
    expect(markdown).toContain('## Strict offline replay');
    expect(markdown).toContain('Mode: enabled');
    expect(markdown).toContain('Aborted unstubbed requests: 17');

    const offMarkdown = renderReplayMarkdown(offReport);
    expect(offMarkdown).not.toContain('## Strict offline replay');
  });

  it('computeReplayDelays caps idle gaps and applies the speed multiplier', () => {
    // Recorded events: a 17-second idle gap up front, then quick navs.
    const events = [
      { atMs: 0 },
      { atMs: 17_000 },
      { atMs: 17_500 },
      { atMs: 19_000 },
      { atMs: 90_000 },
    ];

    // Default — gaps capped at 1500ms.
    const defaultDelays = computeReplayDelays(events);
    expect(defaultDelays).toEqual([0, 1500, 2000, 3500, 5000]);

    // Raw timing preserved when maxIdleGapMs is Infinity.
    const rawDelays = computeReplayDelays(events, { maxIdleGapMs: Number.POSITIVE_INFINITY });
    expect(rawDelays).toEqual([0, 17_000, 17_500, 19_000, 90_000]);

    // Speed multiplier scales every gap (after capping). speed=2 halves.
    const fastDelays = computeReplayDelays(events, { speed: 2 });
    expect(fastDelays).toEqual([0, 750, 1000, 1750, 2500]);

    // Tight cap + slow speed.
    const tightSlow = computeReplayDelays(events, { maxIdleGapMs: 500, speed: 0.5 });
    expect(tightSlow).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('applies canonicalThreadUrl during conversion so provider locale params do not split canonicals', () => {
    const pack = createSessionPackFromManualRecorder({
      captureLevel: 'html',
      sidetrackVersion: 'test',
      sessionId: 'ses_01HX0000000000000000000003',
      recordedAt: '2026-05-09T12:00:00.000Z',
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: 'ws_t1',
          events: [
            {
              at: '2026-05-09T12:00:00.000Z',
              kind: 'page-opened',
              pageId: 'p01',
              pageUrl: 'about:blank',
            },
            {
              at: '2026-05-09T12:00:00.100Z',
              kind: 'navigation',
              pageId: 'p01',
              pageUrl: 'https://gemini.google.com/app/abc?hl=en-US',
              title: 'Gemini',
            },
          ],
          snapshots: [
            {
              capturedAt: '2026-05-09T12:00:00.150Z',
              pageId: 'p01',
              reason: 'navigation',
              url: 'https://gemini.google.com/app/abc?hl=en-US',
              title: 'Gemini',
              html: '<main>Gemini</main>',
            },
          ],
        },
      ],
    });
    const browser = pack.browsers[0];
    const navigation = browser.events.find((event) => event.kind === 'navigation');
    expect(navigation).toBeDefined();
    if (navigation === undefined || navigation.kind !== 'navigation') {
      throw new Error('expected a navigation event');
    }
    // Runtime canonicalization strips ?hl=en-US for Gemini app URLs;
    // pack must mirror that or replay will report unexpected/missing.
    expect(navigation.canonicalUrl).toBe('https://gemini.google.com/app/abc');
    // The bare URL (the one page.goto will use during replay) keeps
    // the locale param so route stubs match the recorded request.
    expect(navigation.url).toBe('https://gemini.google.com/app/abc?hl=en-US');
    // Snapshot is keyed by canonicalUrl, not url, so installRouteStubsForPack
    // can find it via the navigation's canonicalUrl.
    expect(Object.keys(browser.snapshots)).toEqual(['https://gemini.google.com/app/abc']);
  });

  it('routeKeyFor normalizes trailing slashes so /pulls and /pulls/ match', () => {
    expect(routeKeyFor('https://example.test/pulls')).toBe('https://example.test/pulls');
    expect(routeKeyFor('https://example.test/pulls/')).toBe('https://example.test/pulls');
    expect(routeKeyFor('https://example.test/')).toBe('https://example.test/');
    expect(routeKeyFor('https://example.test')).toBe('https://example.test/');
    expect(routeKeyFor('https://example.test/path?q=1')).toBe('https://example.test/path');
    expect(routeKeyFor('not a url')).toBe('not a url');
    expect(routeKeyFor('not a url?with=qs')).toBe('not a url');
  });

  it('privacy gate accepts inline-script localStorage references in redacted HTML', () => {
    const pack = basePack();
    const browser = pack.browsers[0];
    const htmlPack: SessionPack = {
      ...pack,
      mode: { browsers: 1, captureLevel: 'html' },
      browsers: [
        {
          ...browser,
          snapshots: {
            'https://example.test/a': {
              capturedAt: '2026-05-09T12:00:00.000Z',
              title: 'Example',
              htmlRedacted:
                '<html><body><script>localStorage.setItem("k","v"); sessionStorage.getItem("x");</script></body></html>',
              redactionCounts: { email: 0 },
            },
          },
        },
      ],
    };
    expect(() => {
      assertPackPrivacy(htmlPack);
    }).not.toThrow();
  });

  it('privacy gate still rejects authorization headers, bearer tokens, and provider keys', () => {
    const pack = basePack();
    const browser = pack.browsers[0];
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ['Authorization: Bearer abc.def-123', 'authorization header', /authorization header/u],
      [
        'Bearer abcdefghijklmnop',
        'bearer token',
        /bearer token|authorization header/u,
      ],
      ['Set-Cookie: sid=abc', 'set-cookie header', /set-cookie header/u],
      ['cookie: sid=abc', 'cookie header', /cookie header/u],
      ['ghp_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'GitHub token', /GitHub token/u],
      ['sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'OpenAI key', /OpenAI key/u],
    ];
    for (const [snippet, label, expected] of cases) {
      const tainted: SessionPack = {
        ...pack,
        mode: { browsers: 1, captureLevel: 'html' },
        browsers: [
          {
            ...browser,
            snapshots: {
              'https://example.test/a': {
                capturedAt: '2026-05-09T12:00:00.000Z',
                title: 'Example',
                htmlRedacted: `<body>${snippet}</body>`,
                redactionCounts: { email: 0 },
              },
            },
          },
        ],
      };
      expect(
        () => {
          assertPackPrivacy(tainted);
        },
        `expected ${label} to trip the deny-list`,
      ).toThrow(expected);
    }
  });

  it('writes local-only pack.json under the selected session root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sidetrack-rr-unit-'));
    try {
      const pack = basePack();
      const written = await writeSessionPack(pack, root);
      expect(written.packPath).toBe(path.join(root, pack.sessionId, 'pack.json'));
      const raw = await readFile(written.packPath, 'utf8');
      expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, sessionId: pack.sessionId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
