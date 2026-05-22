import { describe, expect, it } from 'vitest';

import {
  E5_INPUT_TOKEN_BUDGET,
  buildSemanticEvidence,
  canEmbedAsSemantic,
  packEvidence,
  summarizeEvidence,
  type EvidenceItem,
} from './evidence.js';

describe('canEmbedAsSemantic', () => {
  it('excludes only UNCORROBORATED_URL_IDENTITY', () => {
    expect(canEmbedAsSemantic('TITLE_META')).toBe(true);
    expect(canEmbedAsSemantic('VISIBLE_CONTENT')).toBe(true);
    expect(canEmbedAsSemantic('CAPTURED_INTERACTION_TEXT')).toBe(true);
    expect(canEmbedAsSemantic('CORROBORATED_URL_SLUG')).toBe(true);
    expect(canEmbedAsSemantic('UNCORROBORATED_URL_IDENTITY')).toBe(false);
  });
});

describe('buildSemanticEvidence — the canonical v2 failure cases', () => {
  it('chatgpt /c/<uuid> URL: title tokens are TITLE_META, hash is dropped, "c" is dropped', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl: 'https://chatgpt.com/c/6a0ca209-f794-8329-8786-8d26494572e0',
      title: 'Linux Kernel Vulnerabilities',
    });
    // The title contributes
    const titleTokens = ev.filter((i) => i.source === 'TITLE_META').map((i) => i.token);
    expect(titleTokens).toEqual(expect.arrayContaining(['linux', 'kernel', 'vulnerabilities']));
    // No URL-identity tokens — "c" is single-char, the UUID is structural
    const urlTokens = ev.filter(
      (i) =>
        i.source === 'CORROBORATED_URL_SLUG' ||
        i.source === 'UNCORROBORATED_URL_IDENTITY',
    );
    expect(urlTokens).toEqual([]);
  });

  it('chatgpt /checkout/openai_llc/cs_live_<opaque>: opaque tail never enters embed text', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl:
        'https://chatgpt.com/checkout/openai_llc/cs_live_a1rV95tH1R8esch5Y',
      title: 'Chat',
    });
    // The opaque billing-id substring NEVER reaches the packed text
    // — it's either structurally classified as opaque (isMixed-
    // AlnumOpaque) and skipped in buildSemanticEvidence, or marked
    // UNCORROBORATED_URL_IDENTITY which packEvidence then drops.
    // Either way, downstream sees zero of it.
    const packed = packEvidence(ev);
    expect(packed).not.toContain('a1rv95th1r8esch5y');
    // Natural-word segments (checkout, openai_llc) DO appear in the
    // evidence stream — but as UNCORROBORATED_URL_IDENTITY because
    // title "Chat" doesn't echo them, so packEvidence drops them too.
    expect(packed).not.toContain('checkout');
    const checkout = ev.find((i) => i.token === 'checkout');
    expect(checkout?.source).toBe('UNCORROBORATED_URL_IDENTITY');
  });

  it('aws security bulletin: path words corroborated by title/content pass as CORROBORATED_URL_SLUG', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl: 'https://aws.amazon.com/security/bulletins/aws-2026-029',
      title: 'AWS Security Bulletin — Linux Kernel Fragnesia CVE',
      content: {
        keyphrases: [{ term: 'Linux kernel' }, { term: 'Fragnesia CVE' }],
        entities: [{ text: 'AWS' }],
        terms: [{ term: 'bulletin security' }, { term: 'bulletins' }],
      },
    });
    const slug = ev.filter((i) => i.source === 'CORROBORATED_URL_SLUG').map((i) => i.token);
    // "security" appears in title → CORROBORATED
    expect(slug).toContain('security');
    // "bulletins" appears in content terms → CORROBORATED (analyzer
    // tokens are exact; "bulletin" wouldn't corroborate "bulletins"
    // without a stemmer, which is a future concern)
    expect(slug).toContain('bulletins');
    // "aws-2026-029" is interesting: "aws" corroborated (entity),
    // "2026-029" — the year prefix "2026" isn't a structural date
    // (needs MM-DD), and "029" is 3 digits which isn't a timestamp;
    // these fall through to uncorroborated. The exact behavior on
    // "aws-2026-029" depends on analyzer splitting; what matters is
    // "security" + "bulletins" both pass corroboration.
  });

  it('bare host URL (https://chatgpt.com): no semantic evidence at all', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl: 'https://chatgpt.com',
    });
    expect(ev).toEqual([]);
  });
});

describe('buildSemanticEvidence — corroboration mechanics', () => {
  it('URL slug appearing in title gets CORROBORATED_URL_SLUG', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl: 'https://example.com/security/audit',
      title: 'Quarterly security audit report',
    });
    const sec = ev.find((i) => i.token === 'security' && i.source === 'CORROBORATED_URL_SLUG');
    const aud = ev.find((i) => i.token === 'audit' && i.source === 'CORROBORATED_URL_SLUG');
    expect(sec).toBeDefined();
    expect(aud).toBeDefined();
  });

  it('URL slug appearing in content keyphrases gets CORROBORATED_URL_SLUG', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl: 'https://example.com/kubernetes/scaling',
      title: 'Cluster operations',
      content: { keyphrases: [{ term: 'kubernetes autoscaler' }, { term: 'pod scaling' }] },
    });
    const kube = ev.find((i) => i.token === 'kubernetes' && i.source === 'CORROBORATED_URL_SLUG');
    const scl = ev.find((i) => i.token === 'scaling' && i.source === 'CORROBORATED_URL_SLUG');
    expect(kube).toBeDefined();
    expect(scl).toBeDefined();
  });

  it('URL slug NOT appearing anywhere gets UNCORROBORATED_URL_IDENTITY', () => {
    const ev = buildSemanticEvidence({
      canonicalUrl: 'https://example.com/random/page',
      title: 'Some unrelated heading',
    });
    const rnd = ev.find((i) => i.token === 'random' && i.source === 'UNCORROBORATED_URL_IDENTITY');
    expect(rnd).toBeDefined();
  });
});

describe('packEvidence', () => {
  it('drops UNCORROBORATED_URL_IDENTITY items entirely', () => {
    const items: EvidenceItem[] = [
      { token: 'linux', source: 'TITLE_META', rank: 0 },
      { token: 'kernel', source: 'TITLE_META', rank: 1 },
      { token: 'mystery', source: 'UNCORROBORATED_URL_IDENTITY', rank: 0 },
    ];
    const text = packEvidence(items, 100);
    expect(text).toBe('linux kernel');
  });

  it('dedupes by token (case-insensitive after analyze())', () => {
    const items: EvidenceItem[] = [
      { token: 'linux', source: 'TITLE_META', rank: 0 },
      { token: 'linux', source: 'VISIBLE_CONTENT', rank: 0 },
      { token: 'kernel', source: 'VISIBLE_CONTENT', rank: 1 },
    ];
    const text = packEvidence(items, 100);
    expect(text).toBe('linux kernel');
  });

  it('stops at the embedder budget', () => {
    const items: EvidenceItem[] = Array.from({ length: 1000 }, (_, i) => ({
      token: `word${String(i)}`,
      source: 'VISIBLE_CONTENT' as const,
      rank: i,
    }));
    const tiny = packEvidence(items, 4);
    // Budget 4 ≈ 1-2 short English tokens — definitely much less than 1000
    expect(tiny.split(' ').length).toBeLessThan(10);
  });

  it('CJK tokens cost ~1 per character (heavier than English)', () => {
    const items: EvidenceItem[] = [
      { token: '分布式系统', source: 'TITLE_META', rank: 0 }, // 5 CJK chars ≈ 5 tokens
      { token: 'a', source: 'TITLE_META', rank: 1 }, // ~0.25 + 1 separator
    ];
    // budget 6 → fits both
    expect(packEvidence(items, 10)).toBe('分布式系统 a');
    // budget 4 → first CJK token alone (5 ideo + 1 sep = 6) blows
    // the budget, so result is empty.
    expect(packEvidence(items, 4)).toBe('');
  });

  it('the linux-cve canonical pair embeds to NON-OVERLAPPING text (no token in common)', () => {
    // The whole point: under v2 these two URLs collided at 0.878
    // cosine purely from shared "chatgpt.com c <hash>" tokens.
    // Under the evidence layer their embed inputs share zero tokens.
    const a = packEvidence(
      buildSemanticEvidence({
        canonicalUrl: 'https://chatgpt.com/c/6a0ca209-f794-8329-8786-8d26494572e0',
        title: 'Linux Kernel Vulnerabilities',
      }),
    );
    const b = packEvidence(
      buildSemanticEvidence({
        canonicalUrl: 'https://chatgpt.com/c/6a0def77-04a0-8325-bc6a-cb0fca771ed2',
        title: '分布式系统测试框架',
      }),
    );
    const tokensA = new Set(a.split(' '));
    const tokensB = new Set(b.split(' '));
    const overlap = [...tokensA].filter((t) => tokensB.has(t));
    expect(overlap).toEqual([]);
  });

  it('the linux-cve canonical pair vs cross-host topic-aligned pair: cross-host CAN share content tokens', () => {
    // Demonstrating the OTHER half: when topic genuinely overlaps,
    // even cross-host pairs share embed tokens — which is what we
    // want.
    const chatLinux = packEvidence(
      buildSemanticEvidence({
        canonicalUrl: 'https://chatgpt.com/c/6a0ca209-f794-8329-8786-8d26494572e0',
        title: 'Linux Kernel Vulnerabilities',
      }),
    );
    const awsLinux = packEvidence(
      buildSemanticEvidence({
        canonicalUrl: 'https://aws.amazon.com/security/bulletins/aws-2026-029',
        title: 'AWS Security Bulletin — Linux Kernel Fragnesia CVE',
        content: {
          keyphrases: [{ term: 'Linux kernel' }, { term: 'Fragnesia CVE' }],
        },
      }),
    );
    const tokensA = new Set(chatLinux.split(' '));
    const tokensB = new Set(awsLinux.split(' '));
    const overlap = [...tokensA].filter((t) => tokensB.has(t));
    expect(overlap).toEqual(expect.arrayContaining(['linux', 'kernel']));
  });
});

describe('summarizeEvidence', () => {
  it('counts items by source and reports hasSemanticEvidence', () => {
    const items: EvidenceItem[] = [
      { token: 'a', source: 'TITLE_META', rank: 0 },
      { token: 'b', source: 'TITLE_META', rank: 1 },
      { token: 'c', source: 'UNCORROBORATED_URL_IDENTITY', rank: 0 },
    ];
    const p = summarizeEvidence(items);
    expect(p.bySource.TITLE_META).toBe(2);
    expect(p.bySource.UNCORROBORATED_URL_IDENTITY).toBe(1);
    expect(p.hasSemanticEvidence).toBe(true);
  });

  it('returns hasSemanticEvidence=false when only uncorroborated identity present', () => {
    const items: EvidenceItem[] = [
      { token: 'x', source: 'UNCORROBORATED_URL_IDENTITY', rank: 0 },
    ];
    const p = summarizeEvidence(items);
    expect(p.hasSemanticEvidence).toBe(false);
  });
});

describe('E5_INPUT_TOKEN_BUDGET', () => {
  it('is the e5 max sequence length, not a tunable knob', () => {
    expect(E5_INPUT_TOKEN_BUDGET).toBe(512);
  });
});
