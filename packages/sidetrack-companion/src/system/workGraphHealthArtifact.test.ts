import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectWorkGraphHealth } from './workGraphHealth.js';
import {
  WORKGRAPH_HEALTH_ARTIFACT_MAX_AGE_MS,
  WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION,
  isWorkGraphHealthArtifactFresh,
  readWorkGraphHealthArtifact,
  workGraphHealthArtifactPath,
  writeWorkGraphHealthArtifact,
} from './workGraphHealthArtifact.js';

describe('workGraph health artifact', () => {
  let vaultRoot = '';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-workgraph-artifact-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('round-trips a report through write + read', async () => {
    // Real report from the real collector (empty vault) so the round
    // trip covers the actual serialized shape, not a hand-rolled stub.
    const report = await collectWorkGraphHealth({ vaultRoot });
    await writeWorkGraphHealthArtifact(
      vaultRoot,
      report,
      () => new Date('2026-07-09T10:00:00.000Z'),
    );

    const artifact = await readWorkGraphHealthArtifact(vaultRoot);
    expect(artifact).not.toBeNull();
    expect(artifact?.schemaVersion).toBe(WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION);
    expect(artifact?.generatedAt).toBe('2026-07-09T10:00:00.000Z');
    expect(artifact?.report).toEqual(report);
  });

  it('returns null when no artifact exists', async () => {
    await expect(readWorkGraphHealthArtifact(vaultRoot)).resolves.toBeNull();
  });

  it('returns null for a corrupt (unparseable) artifact file', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    await writeFile(workGraphHealthArtifactPath(vaultRoot), '{ not json', 'utf8');

    await expect(readWorkGraphHealthArtifact(vaultRoot)).resolves.toBeNull();
  });

  it('returns null on schemaVersion mismatch', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    await writeFile(
      workGraphHealthArtifactPath(vaultRoot),
      `${JSON.stringify({
        schemaVersion: 999,
        generatedAt: '2026-07-09T10:00:00.000Z',
        report: {},
      })}\n`,
      'utf8',
    );

    await expect(readWorkGraphHealthArtifact(vaultRoot)).resolves.toBeNull();
  });

  it('returns null for a malformed envelope (missing generatedAt / report)', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    await writeFile(
      workGraphHealthArtifactPath(vaultRoot),
      `${JSON.stringify({ schemaVersion: WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION, report: {} })}\n`,
      'utf8',
    );
    await expect(readWorkGraphHealthArtifact(vaultRoot)).resolves.toBeNull();

    await writeFile(
      workGraphHealthArtifactPath(vaultRoot),
      `${JSON.stringify({
        schemaVersion: WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION,
        generatedAt: '2026-07-09T10:00:00.000Z',
        report: 'not-a-record',
      })}\n`,
      'utf8',
    );
    await expect(readWorkGraphHealthArtifact(vaultRoot)).resolves.toBeNull();
  });

  it('isWorkGraphHealthArtifactFresh bounds the serve-side age', async () => {
    const report = await collectWorkGraphHealth({ vaultRoot });
    const now = new Date('2026-07-10T12:00:00.000Z');
    const artifactAt = (generatedAt: string) => ({
      schemaVersion: WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION,
      generatedAt,
      report,
    });

    // Just inside the bound vs just past it.
    const insideMs = now.getTime() - WORKGRAPH_HEALTH_ARTIFACT_MAX_AGE_MS;
    expect(
      isWorkGraphHealthArtifactFresh(artifactAt(new Date(insideMs).toISOString()), () => now),
    ).toBe(true);
    expect(
      isWorkGraphHealthArtifactFresh(artifactAt(new Date(insideMs - 1).toISOString()), () => now),
    ).toBe(false);
    // Unparseable timestamps fail toward the live fallback.
    expect(isWorkGraphHealthArtifactFresh(artifactAt('not-a-date'), () => now)).toBe(false);
  });
});
