import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getModelCacheStatus, isOfflineMode, resolveModelsDir } from './modelCache.js';
import { RECALL_MODEL, RECALL_MODEL_ID } from './modelManifest.js';

describe('modelManifest', () => {
  it('produces a stable identity string that includes the revision', () => {
    expect(RECALL_MODEL_ID).toContain(RECALL_MODEL.modelId);
    expect(RECALL_MODEL_ID).toContain(`rev=${RECALL_MODEL.revision}`);
    expect(RECALL_MODEL_ID).toContain('prefix-query-v1');
  });

  it('exposes the embedder dim + dtype cascade', () => {
    expect(RECALL_MODEL.embeddingDim).toBe(384);
    expect(RECALL_MODEL.dtypePreference).toEqual(['q8', 'fp16', 'fp32']);
    expect(RECALL_MODEL.inputPrefix).toBe('query: ');
  });
});

describe('modelCache', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('resolveModelsDir', () => {
    it('honors the explicit option over env over default', () => {
      process.env['SIDETRACK_MODELS_DIR'] = '/from/env/dir';
      expect(resolveModelsDir({ modelsDir: '/from/option/dir' })).toBe('/from/option/dir');
    });

    it('falls back to the env when no option is passed', () => {
      process.env['SIDETRACK_MODELS_DIR'] = '/from/env/dir';
      expect(resolveModelsDir()).toBe('/from/env/dir');
    });

    it('falls back to the platform default when neither option nor env is set', () => {
      delete process.env['SIDETRACK_MODELS_DIR'];
      const dir = resolveModelsDir();
      // Just check the path is rooted at $HOME / <something Sidetrack>
      // since the platform-specific suffix differs across runs.
      expect(dir.length).toBeGreaterThan(0);
      expect(dir.toLowerCase()).toContain('sidetrack');
    });
  });

  describe('isOfflineMode', () => {
    it('returns false by default', () => {
      delete process.env['SIDETRACK_OFFLINE_MODELS'];
      expect(isOfflineMode()).toBe(false);
    });

    it('honors SIDETRACK_OFFLINE_MODELS=1', () => {
      process.env['SIDETRACK_OFFLINE_MODELS'] = '1';
      expect(isOfflineMode()).toBe(true);
    });

    it('honors SIDETRACK_OFFLINE_MODELS=true', () => {
      process.env['SIDETRACK_OFFLINE_MODELS'] = 'true';
      expect(isOfflineMode()).toBe(true);
    });

    it('explicit option wins over env', () => {
      process.env['SIDETRACK_OFFLINE_MODELS'] = '1';
      expect(isOfflineMode({ offline: false })).toBe(false);
    });
  });

  describe('getModelCacheStatus', () => {
    let cacheDir: string;

    beforeEach(async () => {
      cacheDir = await mkdtemp(join(tmpdir(), 'sidetrack-modelcache-'));
    });

    afterEach(async () => {
      await rm(cacheDir, { recursive: true, force: true });
    });

    it('reports present:false when the model dir is missing', async () => {
      const status = await getModelCacheStatus({ modelsDir: cacheDir, offline: true });
      expect(status.present).toBe(false);
      expect(status.modelId).toBe(RECALL_MODEL.modelId);
      expect(status.revision).toBe(RECALL_MODEL.revision);
      expect(status.cacheDir).toBe(cacheDir);
      expect(status.offline).toBe(true);
      expect(status.verified).toBe(false);
    });

    it('reports present:true when an .onnx file exists in the model tree', async () => {
      const [org, repo] = RECALL_MODEL.modelId.split('/');
      const onnxDir = join(cacheDir, org!, repo!, 'onnx');
      await mkdir(onnxDir, { recursive: true });
      await writeFile(join(onnxDir, 'model_quantized.onnx'), 'fake-onnx');
      const status = await getModelCacheStatus({ modelsDir: cacheDir });
      expect(status.present).toBe(true);
    });

    it('verifies the cached sha when refs/main matches the manifest revision', async () => {
      const [org, repo] = RECALL_MODEL.modelId.split('/');
      const modelTree = join(cacheDir, org!, repo!);
      await mkdir(join(modelTree, 'onnx'), { recursive: true });
      await writeFile(join(modelTree, 'onnx', 'model_quantized.onnx'), 'fake-onnx');
      // Drop a refs/main token containing the pinned sha.
      await mkdir(join(modelTree, 'refs'), { recursive: true });
      await writeFile(join(modelTree, 'refs', 'main'), `${RECALL_MODEL.revision}\n`);
      const status = await getModelCacheStatus({ modelsDir: cacheDir });
      expect(status.present).toBe(true);
      expect(status.verified).toBe(true);
    });

    it('reports verified:false when the cached sha differs from the manifest revision', async () => {
      const [org, repo] = RECALL_MODEL.modelId.split('/');
      const modelTree = join(cacheDir, org!, repo!);
      await mkdir(join(modelTree, 'onnx'), { recursive: true });
      await writeFile(join(modelTree, 'onnx', 'model_quantized.onnx'), 'fake-onnx');
      await mkdir(join(modelTree, 'refs'), { recursive: true });
      await writeFile(join(modelTree, 'refs', 'main'), 'a'.repeat(40));
      const status = await getModelCacheStatus({ modelsDir: cacheDir });
      expect(status.present).toBe(true);
      expect(status.verified).toBe(false);
    });
  });
});
