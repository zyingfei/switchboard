import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_WORKSTREAM_STORAGE_KEY,
  assertNoDisallowedStorageValues,
  assertPackPrivacy,
  createRunId,
  createSessionId,
  recordedCanonicalUrls,
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
  it('defaults captureLevel to minimal and rejects richer Wave 2 modes in 2a', () => {
    expect(resolveCaptureLevel({})).toBe('minimal');
    expect(resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'minimal' })).toBe('minimal');
    expect(() => resolveCaptureLevel({ SIDETRACK_CAPTURE_LEVEL: 'html' })).toThrow(/Wave 2a/u);
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
