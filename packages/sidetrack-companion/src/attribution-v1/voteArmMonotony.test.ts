// The MISSED test class (fix/vote-arm-precision) — the monotony acceptance test.
//
// The live failure (2026-07-26): on a lightly-filed vault the unguarded vote arm
// collapsed onto the recent/dominant workstream — three unrelated pages (a
// design essay, an economics article, a GitHub security blog) resolved to TWO
// workstreams, one at auto-apply. The prequential top1 masked it because
// historical labels cluster in temporal bursts where recency is predictive.
//
// This suite encodes the class the eval missed:
//   1. N diverse UNFILED pages + one recent filing MUST NOT resolve a MAJORITY of
//      them to the same workstream under the guarded arm (the correlated-prior
//      guard abstains when the per-page title vote does not participate).
//   2. The live 3-URL probe (design essay / economics article / GitHub blog):
//      three distinct pages must NOT all get the same answer.
//   3. github.com's domain vote is hub-gated (the registry fix) so its domain
//      argmax cannot sweep unrelated repos.

import { describe, expect, it } from 'vitest';

import { resolveUrlAttributionVote3 } from './serve.js';
import { buildAttributionV1State } from './state.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

let seq = 0;
const organize = (url: string, ws: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `org-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `canonical-url:${url}`,
    type: USER_ORGANIZED_ITEM,
    payload: { payloadVersion: 1, itemKind: 'canonical-url', itemId: url, action: 'move', toContainer: ws },
    acceptedAtMs: atMs,
  };
};
const timeline = (url: string, title: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `tl-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: `timeline-visit:${url}`,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `evt-${seq}`,
      observedAt: new Date(atMs).toISOString(),
      url,
      canonicalUrl: url,
      title,
      transition: 'activated',
    },
    acceptedAtMs: atMs,
  };
};

// The winning workstream a fresh visit resolves to (null when the arm abstains).
const resolvedWorkstream = (
  state: ReturnType<typeof buildAttributionV1State>,
  url: string,
  title: string | null,
): string | null => {
  const r = resolveUrlAttributionVote3({ state, canonicalUrl: url, title });
  return r.decision.action === 'inbox' ? null : (r.decision.workstreamId ?? null);
};

describe('vote arm — monotony acceptance (the missed test class)', () => {
  it('N diverse UNFILED pages + one recent filing do NOT collapse onto one workstream', () => {
    // A LIGHTLY-FILED vault: one filing burst into wsAI (so recency + a domain
    // argmax both point at wsAI — the near-global priors), plus a couple of other
    // sparse filings. Then probe 5 DIVERSE unfiled pages whose titles overlap
    // NOTHING filed. The unguarded arm would suggest wsAI (recency, +domain where
    // it matches) for most of them; the guarded arm must NOT resolve a MAJORITY
    // to any single workstream.
    seq = 0;
    const events: AcceptedEvent[] = [
      // wsAI filing burst (recent + dominant).
      timeline('https://openai.example/gpt', 'gpt scaling laws transformer', 1),
      timeline('https://openai.example/rl', 'reinforcement learning from feedback', 2),
      organize('https://openai.example/gpt', 'wsAI', 10),
      organize('https://openai.example/rl', 'wsAI', 11),
      // a couple of unrelated sparse filings on OTHER domains.
      timeline('https://cooking.example/bread', 'sourdough bread fermentation', 3),
      organize('https://cooking.example/bread', 'wsCooking', 12),
      // wsAI filed LAST so recency points at wsAI (the failure precondition).
      timeline('https://openai.example/agents', 'autonomous agents planning', 4),
      organize('https://openai.example/agents', 'wsAI', 20),
    ];
    const state = buildAttributionV1State(events);

    // 5 diverse UNFILED pages on fresh domains, titles overlapping nothing filed.
    const probes: [string, string][] = [
      ['https://stephango.example/file-over-app', 'file over app durable formats essay'],
      ['https://siepr.example/inequality', 'wealth inequality macroeconomics study'],
      ['https://gardening.example/tomatoes', 'growing heirloom tomatoes trellis'],
      ['https://astronomy.example/jwst', 'james webb deep field galaxies'],
      ['https://law.example/contracts', 'contract law consideration doctrine'],
    ];
    const answers = probes.map(([u, t]) => resolvedWorkstream(state, u, t));

    // Count the most-frequent NON-null answer. It must not be a majority of the
    // probes — no single workstream may sweep the diverse fresh browsing.
    const counts = new Map<string, number>();
    for (const a of answers) if (a !== null) counts.set(a, (counts.get(a) ?? 0) + 1);
    const topRepeat = [...counts.values()].reduce((m, c) => Math.max(m, c), 0);
    expect(topRepeat).toBeLessThanOrEqual(Math.floor(probes.length / 2));
    // wsAI (the recent/dominant prior) must NOT be suggested for a majority.
    expect(counts.get('wsAI') ?? 0).toBeLessThanOrEqual(Math.floor(probes.length / 2));
  });

  it('the live 3-URL probe: three distinct pages are NOT all the same answer', () => {
    // The exact live shape: one filing burst (wsWork, recent), then three
    // unrelated pages that the unguarded arm swept onto wsWork. Under the guard
    // (their titles overlap nothing filed ⇒ no title vote) they cannot all
    // resolve to wsWork.
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://work.example/a', 'quarterly roadmap planning okr', 1),
      timeline('https://work.example/b', 'sprint retro velocity metrics', 2),
      organize('https://work.example/a', 'wsWork', 10),
      organize('https://work.example/b', 'wsWork', 11),
    ];
    const state = buildAttributionV1State(events);

    const a = resolvedWorkstream(state, 'https://stephango.example/essay', 'file over app design essay');
    const b = resolvedWorkstream(state, 'https://siepr.example/econ', 'stanford economics inequality article');
    const c = resolvedWorkstream(
      state,
      'https://github.example/blog/security',
      'github security advisory supply chain',
    );
    // The three answers must NOT all be identical (the monotone-collapse failure).
    const distinct = new Set([a, b, c].filter((x) => x !== null));
    expect([a, b, c].every((x) => x === 'wsWork')).toBe(false);
    // Ideally all three abstain (no page evidence) — assert none is the dominant
    // wsWork for more than one of them.
    const wsWorkCount = [a, b, c].filter((x) => x === 'wsWork').length;
    expect(wsWorkCount).toBeLessThanOrEqual(1);
    // Sanity: the guard does not somehow invent a third bogus grouping.
    expect(distinct.size).toBeLessThanOrEqual(2);
  });

  it("github.com's domain vote is hub-gated — an unrelated repo is not swept onto the github argmax", () => {
    // File two github repos into wsInfra so the github.com domain argmax = wsInfra
    // (the ad-hoc pre-fix behaviour). A THIRD, unrelated github repo with a title
    // overlapping nothing filed must NOT resolve to wsInfra on the domain channel:
    // github.com is now a hub-gated domain (COARSE_MULTI_TOPIC_DOMAIN_PRIOR), so
    // its domain vote is withheld until per-repo evidence overrides the prior.
    seq = 0;
    const events: AcceptedEvent[] = [
      timeline('https://github.com/acme/infra-tools', 'kubernetes terraform deploy', 1),
      timeline('https://github.com/acme/infra-cd', 'argocd gitops pipeline', 2),
      organize('https://github.com/acme/infra-tools', 'wsInfra', 10),
      organize('https://github.com/acme/infra-cd', 'wsInfra', 11),
      // A last filing elsewhere so recency does not point at wsInfra either.
      timeline('https://novel.example/x', 'creative writing fiction workshop', 3),
      organize('https://novel.example/x', 'wsWriting', 20),
    ];
    const state = buildAttributionV1State(events);

    // A fresh, unrelated github repo. No title overlap, hub-gated domain, recency
    // points at wsWriting ⇒ the arm must NOT surface wsInfra (the github argmax).
    const answer = resolvedWorkstream(
      state,
      'https://github.com/someone/quantum-chem',
      'density functional theory simulation',
    );
    expect(answer).not.toBe('wsInfra');
  });
});
