import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  armShadowSnapshot,
  attributionArmShadowArtifactPath,
  flushArmShadow,
  recordArmShadow,
  resetArmShadowForTest,
} from './armShadow.js';

describe('armShadow', () => {
  beforeEach(() => resetArmShadowForTest());

  it('starts empty', () => {
    expect(armShadowSnapshot()).toEqual({ requests: 0, agreeRate: 0 });
  });

  it('tracks requests and agree-rate', () => {
    recordArmShadow(true);
    recordArmShadow(false);
    recordArmShadow(true);
    const snap = armShadowSnapshot();
    expect(snap.requests).toBe(3);
    expect(snap.agreeRate).toBeCloseTo(2 / 3, 10);
  });

  describe('flushArmShadow', () => {
    let vaultRoot: string;
    beforeEach(async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'arm-shadow-'));
    });
    afterEach(async () => {
      await rm(vaultRoot, { recursive: true, force: true });
    });

    it('writes the gauge artifact with the running snapshot', async () => {
      recordArmShadow(true);
      recordArmShadow(false);
      const written = await flushArmShadow(vaultRoot, () => new Date('2026-07-26T00:00:00.000Z'));
      expect(written).toEqual({ requests: 2, agreeRate: 0.5 });
      const body = JSON.parse(await readFile(attributionArmShadowArtifactPath(vaultRoot), 'utf8'));
      expect(body.armShadow).toEqual({ requests: 2, agreeRate: 0.5 });
      expect(body.generatedAt).toBe('2026-07-26T00:00:00.000Z');
    });

    it('is a no-op when there are no requests (idle companion does not churn)', async () => {
      const written = await flushArmShadow(vaultRoot);
      expect(written).toBeNull();
      await expect(
        readFile(attributionArmShadowArtifactPath(vaultRoot), 'utf8'),
      ).rejects.toThrow();
    });
  });
});
