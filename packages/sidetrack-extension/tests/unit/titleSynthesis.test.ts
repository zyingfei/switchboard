import { describe, expect, it, vi } from 'vitest';

import {
  contentHashOf,
  createNanoSession,
  SESSION_LANGUAGES,
  SLICE_THRESHOLD_CHARS,
  sliceForSynthesis,
  synthesizeTitle,
  type BuiltinLanguageModel,
} from '../../src/sidepanel/nano/titleSynthesis';

describe('sliceForSynthesis', () => {
  it('passes content at or below the threshold through unchanged', () => {
    const short = 'x'.repeat(SLICE_THRESHOLD_CHARS);
    expect(sliceForSynthesis(short)).toBe(short);
    expect(sliceForSynthesis('hi')).toBe('hi');
  });

  it('samples head + middle + tail with … markers for long content, bounded', () => {
    // Per-index char so we can prove exact provenance of each slab. Content
    // length 4000 > threshold (2200). Char at index i encodes i mod 10 —
    // enough to pin the slab boundaries.
    const content = Array.from({ length: 4000 }, (_, i) => String(i % 10)).join('');
    const sliced = sliceForSynthesis(content);

    // Two markers → three slabs joined.
    const parts = sliced.split('\n…\n');
    expect(parts).toHaveLength(3);
    const [headSlab, middleSlab, tailSlab] = parts;

    // Head = first 1400 chars.
    expect(headSlab).toBe(content.slice(0, 1400));
    // Middle = 400 chars centered on the midpoint (index 2000).
    const midStart = 4000 / 2 - 400 / 2; // 1800
    expect(middleSlab).toBe(content.slice(midStart, midStart + 400));
    // Tail = last 400 chars.
    expect(tailSlab).toBe(content.slice(content.length - 400));

    // Bounded: head(1400) + mid(400) + tail(400) + 2 markers, far below input.
    expect(sliced.length).toBeLessThan(content.length);
    expect(sliced.length).toBe(1400 + 400 + 400 + 2 * '\n…\n'.length);
  });
});

describe('contentHashOf', () => {
  it('is stable and hex, and distinguishes different content', () => {
    const a = contentHashOf('hello world');
    expect(a).toBe(contentHashOf('hello world'));
    expect(a).toMatch(/^[0-9a-f]+$/u);
    expect(a).not.toBe(contentHashOf('hello worl d'));
  });
});

describe('createNanoSession', () => {
  // Capability truth (see language.ts): Chrome's built-in Prompt API supports
  // en/ja/es/de/fr — NOT Chinese. The session used to declare ['en','zh'],
  // a promise Nano cannot keep. Chinese now routes to the WebGPU engine.
  it('declares ONLY languages Nano supports — never zh', async () => {
    const session = { destroy: vi.fn(), prompt: vi.fn() };
    const create = vi.fn(async () => session);
    const lm = { availability: vi.fn(), create } as unknown as BuiltinLanguageModel;
    await createNanoSession(lm);
    expect(create).toHaveBeenCalledWith({
      expectedInputs: [{ type: 'text', languages: SESSION_LANGUAGES }],
      expectedOutputs: [{ type: 'text', languages: SESSION_LANGUAGES }],
    });
    expect(SESSION_LANGUAGES).toEqual(['en']);
    expect(SESSION_LANGUAGES).not.toContain('zh');
  });

  it('falls back to a plain create() when the language options are rejected', async () => {
    const session = { destroy: vi.fn(), prompt: vi.fn() };
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('language options unsupported'))
      .mockResolvedValueOnce(session);
    const lm = { availability: vi.fn(), create } as unknown as BuiltinLanguageModel;
    const got = await createNanoSession(lm);
    expect(got).toBe(session);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith();
  });
});

describe('synthesizeTitle', () => {
  const contentOf = (chars: number): string => 'User: how do I analyze CloudTrail logs? '.repeat(
    Math.ceil(chars / 40),
  ).slice(0, chars);

  it('returns the trimmed title for good content', async () => {
    const prompt = vi.fn(async () => '  CloudTrail log analysis pipeline design  ');
    const destroy = vi.fn();
    const lm = {
      availability: vi.fn(),
      create: vi.fn(async () => ({ prompt, destroy })),
    } as unknown as BuiltinLanguageModel;
    const title = await synthesizeTitle(lm, contentOf(200));
    expect(title).toBe('CloudTrail log analysis pipeline design');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('returns null on thin content without ever creating a session', async () => {
    const create = vi.fn();
    const lm = { availability: vi.fn(), create } as unknown as BuiltinLanguageModel;
    expect(await synthesizeTitle(lm, 'too short')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses Chinese content outright — Nano cannot serve it, so no session', async () => {
    const create = vi.fn();
    const lm = { availability: vi.fn(), create } as unknown as BuiltinLanguageModel;
    const zh = '用户：请问如何在多个账户之间分析云端审计日志？这是一个关于安全与合规的问题。'.repeat(4);
    expect(await synthesizeTitle(lm, zh)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when the model replies SKIP', async () => {
    const destroy = vi.fn();
    const lm = {
      availability: vi.fn(),
      create: vi.fn(async () => ({ prompt: async () => 'SKIP', destroy })),
    } as unknown as BuiltinLanguageModel;
    expect(await synthesizeTitle(lm, contentOf(200))).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('returns null on an empty reply', async () => {
    const lm = {
      availability: vi.fn(),
      create: vi.fn(async () => ({ prompt: async () => '   ', destroy: vi.fn() })),
    } as unknown as BuiltinLanguageModel;
    expect(await synthesizeTitle(lm, contentOf(200))).toBeNull();
  });

  it('returns null (and does not throw) when prompt errors, still destroying the session', async () => {
    const destroy = vi.fn();
    const lm = {
      availability: vi.fn(),
      create: vi.fn(async () => ({
        prompt: async () => {
          throw new Error('nano exploded');
        },
        destroy,
      })),
    } as unknown as BuiltinLanguageModel;
    expect(await synthesizeTitle(lm, contentOf(200))).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('caps the title to 200 chars', async () => {
    const lm = {
      availability: vi.fn(),
      create: vi.fn(async () => ({ prompt: async () => 'z'.repeat(500), destroy: vi.fn() })),
    } as unknown as BuiltinLanguageModel;
    const title = await synthesizeTitle(lm, contentOf(200));
    expect(title).toHaveLength(200);
  });
});
