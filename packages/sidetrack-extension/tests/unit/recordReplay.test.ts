import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_WORKSTREAM_STORAGE_KEY,
  assertNoDisallowedStorageValues,
  assertPackPrivacy,
  createSessionPackFromManualRecorder,
  createRunId,
  createSessionId,
  recordedCanonicalUrls,
  redactHtmlForSessionPack,
  resolveCaptureLevel,
  resolveTestSessionsDir,
  sha256Hex,
  writeSessionPack,
  type SessionPack,
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

describe('T1 record/replay session pack helpers', () => {
  it('defaults captureLevel to minimal, accepts Wave 2b html, and keeps html+paste reserved', () => {
    expect(resolveCaptureLevel({})).toBe('minimal');
    expect(resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'minimal' })).toBe('minimal');
    expect(resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'html' })).toBe('html');
    expect(() => resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'html+paste' })).toThrow(
      /Wave 2c/u,
    );
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
