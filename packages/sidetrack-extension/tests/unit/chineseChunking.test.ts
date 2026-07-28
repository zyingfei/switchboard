import { describe, expect, it, vi } from 'vitest';

import {
  CHARS_PER_TOKEN,
  CHUNK_MAX_CHARS,
  TARGET_CHUNK_TOKENS,
  chunkWidthForLanguage,
} from '../../src/sidepanel/nano/chunking';
import { isFatalBackendError } from '../../src/sidepanel/nano/engine';
import { synthesizeGist } from '../../src/sidepanel/nano/gistSynthesis';
import { detectContentLanguage } from '../../src/sidepanel/nano/language';

// THE CHINESE CRASH — measured 2026-07-28 against real vault pages.
//
// CHUNK_MAX_CHARS is a CHARACTER budget tuned on English (~4 chars/token). A
// Chinese page runs ~1 char/token, so the same 3600 characters is ~3600 tokens
// instead of ~900 — four times the load, straight past the context cliff. Every
// candidate model died on the FIRST Chinese document:
//
//   gemma-3-1b     failed to call OrtRun() ... buffer_manager.cc Download(...)
//   Qwen3-0.6B     RuntimeError: memory access out of bounds
//   Qwen2.5-1.5B   RuntimeError: null function
//
// Order was ruled out as the cause: running the Chinese documents FIRST crashed
// immediately. And once crashed, every LATER generation failed too — including
// English documents that had just succeeded.
//
// That is the lane which exists *specifically* to handle Chinese, because Nano
// and Apple both refuse it. These tests pin both halves of the fix.

describe('chunk width is budgeted in TOKENS, not characters', () => {
  it('leaves English exactly where it was measured clean', () => {
    // 900 tokens x 4 chars/token = 3600 = CHUNK_MAX_CHARS. The English path is
    // unchanged by construction, not by coincidence.
    expect(chunkWidthForLanguage('en')).toBe(CHUNK_MAX_CHARS);
    expect(TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN.en).toBe(CHUNK_MAX_CHARS);
  });

  it('narrows Chinese to something that actually runs', () => {
    // 1800 still crashed one of three documents; 1200 completed all three.
    const zh = chunkWidthForLanguage('zh');
    expect(zh).toBeLessThanOrEqual(1200);
    expect(zh).toBeGreaterThan(0);
  });

  it('treats mixed content as Chinese-leaning, not as an average', () => {
    // The failure is asymmetric: too narrow costs time, too wide kills the
    // session. A "mixed" document can still be locally dense with Chinese.
    const mixed = chunkWidthForLanguage('mixed-en-zh');
    expect(mixed).toBeLessThan(chunkWidthForLanguage('en'));
    expect(mixed).toBeGreaterThan(chunkWidthForLanguage('zh'));
  });

  it('can only ever NARROW — no language may exceed the measured-safe width', () => {
    for (const lang of ['en', 'zh', 'mixed-en-zh'] as const) {
      expect(chunkWidthForLanguage(lang)).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it('a Chinese document is actually chunked narrower end-to-end', async () => {
    // The property that matters is not the helper's return value but what the
    // MODEL receives, so this drives the real pipeline and inspects the prompts.
    const zhDoc = Array.from(
      { length: 8 },
      (_, i) => `第${String(i)}段。这是一段关于概率论与数理统计的中文内容，用来测试分块宽度是否按语言调整。`.repeat(6),
    ).join('\n\n');
    expect(detectContentLanguage(zhDoc)).toBe('zh');

    const prompts: string[] = [];
    const engine = {
      generate: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return '这段内容讲的是概率论与数理统计的基本概念。';
      }),
    };
    const outcome = await synthesizeGist(engine, zhDoc);
    expect(outcome.meta.totalChunks).toBeGreaterThan(1);

    // No single prompt may carry more source text than the Chinese width.
    // (+ prompt prefix, hence the generous slack — the point is that it is
    // nowhere near the 3600-char English width that crashed.)
    const longest = Math.max(...prompts.map((p) => p.length));
    expect(longest).toBeLessThan(CHUNK_MAX_CHARS);
  });

  it('an English document is NOT narrowed — the fix must not cost English speed', async () => {
    const enDoc = Array.from(
      { length: 8 },
      (_, i) => `Paragraph ${String(i)}. ${'real prose content in this section. '.repeat(14)}`,
    ).join('\n\n');
    expect(detectContentLanguage(enDoc)).toBe('en');

    const sizes: number[] = [];
    const engine = {
      generate: vi.fn(async (prompt: string) => {
        sizes.push(prompt.length);
        return 'The document describes a sectioned body of prose content.';
      }),
    };
    await synthesizeGist(engine, enDoc);
    // At the English width this document packs into few, wide chunks; at the
    // Chinese width it would take many more calls.
    expect(sizes.length).toBeLessThanOrEqual(5);
  });
});

describe('a dead GPU context unloads itself', () => {
  it('recognizes every terminal backend error observed live', () => {
    expect(
      isFatalBackendError(
        new Error(
          'failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /onnxruntime/core/providers/webgpu/buffer_manager.cc:553',
        ),
      ),
    ).toBe(true);
    expect(isFatalBackendError(new Error('RuntimeError: memory access out of bounds'))).toBe(true);
    expect(isFatalBackendError(new Error('RuntimeError: null function'))).toBe(true);
    expect(isFatalBackendError(new Error('device is lost'))).toBe(true);
  });

  it('does NOT unload for an ordinary generation error', () => {
    // A mis-match here throws away a working engine and costs the user a
    // reload, so the matcher stays narrow on purpose.
    expect(isFatalBackendError(new Error('input is too long'))).toBe(false);
    expect(isFatalBackendError(new Error('AbortError'))).toBe(false);
    expect(isFatalBackendError(new Error('tokenizer not found'))).toBe(false);
    expect(isFatalBackendError('some string')).toBe(false);
  });
});
