import { describe, expect, it } from 'vitest';

import {
  NANO_SESSION_LANGUAGES,
  NANO_SUPPORTED_LANGUAGES,
  detectContentLanguage,
  nanoCanServe,
  routeEnrichmentEngine,
  type ContentLanguage,
  type EngineAvailability,
} from '../../src/sidepanel/nano/language';

// The capability truth this whole module exists for: Chrome's built-in Prompt /
// Summarizer APIs support en/ja/es/de/fr — NOT Chinese. The vault is bilingual,
// so language is a ROUTING input: Chinese must reach the multilingual WebGPU
// model or nothing at all, never Nano.

const EN_TEXT =
  'How do I analyze CloudTrail logs across many AWS accounts? The organization trail writes ' +
  'to a central S3 bucket, and Athena queries it with a partition projection table.';

const ZH_TEXT =
  '如何在多个账户之间分析云端审计日志？组织级追踪会把事件写入中心化的存储桶，' +
  '然后用查询引擎按分区投影表进行检索，这样可以显著降低扫描成本。';

const MIXED_TEXT = `${EN_TEXT}\n\n补充说明：这段中文描述了同样的架构，包括中心化存储、分区投影以及成本控制的取舍。`;

const availability = (over: Partial<EngineAvailability> = {}): EngineAvailability => ({
  nanoReady: false,
  webGpuLoaded: false,
  webGpuLoading: false,
  webGpuSupported: true,
  ...over,
});

describe('detectContentLanguage', () => {
  it('calls English prose en', () => {
    expect(detectContentLanguage(EN_TEXT)).toBe('en');
  });

  it('calls Chinese prose zh', () => {
    expect(detectContentLanguage(ZH_TEXT)).toBe('zh');
  });

  it('calls a bilingual document mixed-en-zh', () => {
    expect(detectContentLanguage(MIXED_TEXT)).toBe('mixed-en-zh');
  });

  it('detects a Chinese title, not just a full page (the pre-run hint)', () => {
    expect(detectContentLanguage('深度学习入门与实践')).toBe('zh');
  });

  it('does NOT let a couple of stray Han glyphs block the Nano route', () => {
    // One CJK term inside a long English page is below both the share and the
    // absolute-count floors.
    expect(detectContentLanguage(`${EN_TEXT} The office is in 北京.`)).toBe('en');
  });

  it('defaults to en for empty / script-free text rather than guessing zh', () => {
    expect(detectContentLanguage('')).toBe('en');
    expect(detectContentLanguage('1234 5678 — 90% (n=12)')).toBe('en');
  });

  it('samples the tail, so a document whose Chinese half is at the end is not missed', () => {
    const long = `${'English filler sentence about storage and queries. '.repeat(120)}${ZH_TEXT.repeat(
      30,
    )}`;
    expect(detectContentLanguage(long)).not.toBe('en');
  });

  it('ignores CJK punctuation as language evidence', () => {
    expect(detectContentLanguage(`${EN_TEXT}。、；：`)).toBe('en');
  });
});

describe('NANO language capability', () => {
  it('declares only languages Nano supports, and never zh', () => {
    expect(NANO_SUPPORTED_LANGUAGES).not.toContain('zh');
    for (const lang of NANO_SESSION_LANGUAGES) {
      expect(NANO_SUPPORTED_LANGUAGES).toContain(lang);
    }
  });

  it('nanoCanServe is English-only', () => {
    expect(nanoCanServe('en')).toBe(true);
    expect(nanoCanServe('zh')).toBe(false);
    expect(nanoCanServe('mixed-en-zh')).toBe(false);
  });
});

describe('routeEnrichmentEngine — the table', () => {
  it('en + nano ready → nano', () => {
    expect(routeEnrichmentEngine('en', availability({ nanoReady: true }))).toEqual({
      engine: 'nano',
    });
  });

  it('en + nano absent + webgpu loaded → webgpu', () => {
    expect(routeEnrichmentEngine('en', availability({ webGpuLoaded: true }))).toEqual({
      engine: 'webgpu',
    });
  });

  it('en + nothing loaded but loadable → typed model-not-loaded (never a load)', () => {
    expect(routeEnrichmentEngine('en', availability())).toEqual({
      engine: null,
      reason: 'model-not-loaded',
    });
  });

  it('en + a load in flight → model-loading', () => {
    expect(routeEnrichmentEngine('en', availability({ webGpuLoading: true }))).toEqual({
      engine: null,
      reason: 'model-loading',
    });
  });

  it('en + no nano + no WebGPU adapter → no-engine', () => {
    expect(routeEnrichmentEngine('en', availability({ webGpuSupported: false }))).toEqual({
      engine: null,
      reason: 'no-engine',
    });
  });

  it('zh + ONLY nano ready → not available, and names the language reason', () => {
    expect(routeEnrichmentEngine('zh', availability({ nanoReady: true }))).toEqual({
      engine: null,
      reason: 'language-needs-local-model',
    });
  });

  it('zh + webgpu loaded → webgpu (even when nano is also ready)', () => {
    expect(
      routeEnrichmentEngine('zh', availability({ nanoReady: true, webGpuLoaded: true })),
    ).toEqual({ engine: 'webgpu' });
  });

  it('mixed + nano ready → not available (a bilingual page is not Nano-safe)', () => {
    expect(routeEnrichmentEngine('mixed-en-zh', availability({ nanoReady: true }))).toEqual({
      engine: null,
      reason: 'language-needs-local-model',
    });
  });

  it('zh + nothing at all → model-not-loaded; zh + no adapter → no-engine', () => {
    expect(routeEnrichmentEngine('zh', availability())).toEqual({
      engine: null,
      reason: 'model-not-loaded',
    });
    expect(routeEnrichmentEngine('zh', availability({ webGpuSupported: false }))).toEqual({
      engine: null,
      reason: 'no-engine',
    });
  });

  it('NEVER selects nano for zh or mixed, across the whole availability space', () => {
    const languages: readonly ContentLanguage[] = ['zh', 'mixed-en-zh'];
    const bools = [false, true];
    for (const language of languages) {
      for (const nanoReady of bools) {
        for (const webGpuLoaded of bools) {
          for (const webGpuLoading of bools) {
            for (const webGpuSupported of bools) {
              const route = routeEnrichmentEngine(
                language,
                { nanoReady, webGpuLoaded, webGpuLoading, webGpuSupported },
              );
              expect(route.engine).not.toBe('nano');
            }
          }
        }
      }
    }
  });

  it('a blocked route always carries a reason — never a silent null', () => {
    const bools = [false, true];
    const languages: readonly ContentLanguage[] = ['en', 'zh', 'mixed-en-zh'];
    for (const language of languages) {
      for (const nanoReady of bools) {
        for (const webGpuLoaded of bools) {
          for (const webGpuLoading of bools) {
            for (const webGpuSupported of bools) {
              const route = routeEnrichmentEngine(
                language,
                { nanoReady, webGpuLoaded, webGpuLoading, webGpuSupported },
              );
              if (route.engine === null) expect(route.reason.length).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });
});
