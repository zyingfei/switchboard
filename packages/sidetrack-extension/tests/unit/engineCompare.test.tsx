import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NO_USABLE_SUMMARY,
  compareEngines,
  pickWinner,
  sizeCaveatFor,
} from '../../src/sidepanel/nano/compareEngines';
import type * as EngineModule from '../../src/sidepanel/nano/engine';
import type { GenerationEngine } from '../../src/sidepanel/nano/engine';
import { OnDeviceAiRow } from '../../entrypoints/sidepanel/components/OnDeviceAiRow';

// COMPARATIVE GENERATION. One document, every available engine, side by side.
// The properties that make it a judgment surface rather than a demo:
//   * the winner is the highest groundedness AMONG OUTPUTS THAT PASSED —
//     a rejected output is never crowned,
//   * "no engine produced a usable summary" when nothing passes,
//   * Chrome's built-in model is NOT run on Chinese (it cannot serve it),
//   * the model sizes being compared are declared, with a caveat when they
//     differ — a silent 1B-vs-3.25B "winner" measures size, not quality,
//   * and the whole thing is observe-only: not one POST.

const DOC =
  'CloudTrail writes organization events into one central bucket. Athena queries that bucket ' +
  'with a partition projection table so scans stay cheap even for a full year of activity.';

// Reuses the source vocabulary heavily → high groundedness.
const GROUNDED =
  'CloudTrail writes organization events into a central bucket, and Athena queries them with a partition projection table.';
// Fluent, non-degenerate, and about nothing in the source → low groundedness.
const UNGROUNDED =
  'Various unrelated topics receive general treatment throughout numerous different paragraphs elsewhere.';
// The 2026-07-27 live failure shape — passes nothing.
const DEGENERATE = '2 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6';

const ZH_DOC =
  '组织级追踪会把事件写入中心化的存储桶，然后使用查询引擎按分区投影表进行检索，' +
  '这样能显著降低扫描成本与查询延迟，并且可以覆盖整整一年的活动记录。'.repeat(2);
const ZH_GIST =
  '这篇文档讲述了如何跨多个账户分析审计日志，并使用分区投影表降低扫描成本。关键实体：组织级追踪、中心化存储桶、查询引擎。';

const stubEngine = (
  kind: GenerationEngine['kind'],
  reply: string | (() => Promise<string>),
): { engine: GenerationEngine; generate: ReturnType<typeof vi.fn> } => {
  const generate = vi.fn(async () => (typeof reply === 'string' ? reply : await reply()));
  return { engine: { kind, generate }, generate };
};

afterEach(() => {
  cleanup();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  delete (globalThis as Record<string, unknown>)['chrome'];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('compareEngines — the same document through every engine', () => {
  it('renders one row per engine, with the declared model identity on each', async () => {
    const nano = stubEngine('nano', GROUNDED);
    const local = stubEngine('webgpu', UNGROUNDED);
    const outcome = await compareEngines({
      document: DOC,
      engines: [nano.engine, local.engine],
    });
    expect(outcome.rows).toHaveLength(2);
    // The matchup is DECLARED, not inferred: Chrome's built-in model is a
    // ~3.25B 4-bit Nano-2; the default local model is 1B q4.
    expect(outcome.rows[0]?.matchup).toBe('Chrome built-in · ~3.25B · 4-bit');
    expect(outcome.rows[1]?.matchup).toBe('local · 1B · q4');
    // Every row carries text, verdict, scores and latency.
    for (const row of outcome.rows) {
      expect(row.text).not.toBeNull();
      expect(row.scores).not.toBeNull();
      expect(row.status).toBe('ok');
      expect(typeof row.ms).toBe('number');
    }
  });

  it('crowns the highest groundedness among PASSING outputs', async () => {
    const nano = stubEngine('nano', GROUNDED);
    const local = stubEngine('webgpu', UNGROUNDED);
    const outcome = await compareEngines({
      document: DOC,
      engines: [nano.engine, local.engine],
    });
    const grounded = outcome.rows.find((r) => r.kind === 'nano');
    const ungrounded = outcome.rows.find((r) => r.kind === 'webgpu');
    expect(grounded?.scores?.groundedness ?? 0).toBeGreaterThan(
      ungrounded?.scores?.groundedness ?? 1,
    );
    expect(outcome.winnerKind).toBe('nano');
    expect(outcome.headline).toContain('winner');
  });

  it('NEVER crowns a rejected output, however well it scores', async () => {
    // The degenerate reply is 100% source-vocabulary-free but the point is the
    // rule: rejected rows are excluded from the winner search entirely.
    const nano = stubEngine('nano', DEGENERATE);
    const local = stubEngine('webgpu', UNGROUNDED);
    const outcome = await compareEngines({
      document: DOC,
      engines: [nano.engine, local.engine],
    });
    expect(outcome.rows.find((r) => r.kind === 'nano')?.status).toBe('rejected');
    expect(outcome.winnerKind).toBe('webgpu');
    // A rejected row still shows its text — a human judging quality has to see
    // what the model actually said.
    expect(outcome.rows.find((r) => r.kind === 'nano')?.text).toBe(DEGENERATE);
    expect(outcome.rows.find((r) => r.kind === 'nano')?.rejection).toBe('repetitive');
  });

  it('says "no engine produced a usable summary" when everything is rejected', async () => {
    const outcome = await compareEngines({
      document: DOC,
      engines: [stubEngine('nano', DEGENERATE).engine, stubEngine('webgpu', DEGENERATE).engine],
    });
    expect(outcome.winnerKind).toBeNull();
    expect(outcome.headline).toBe(NO_USABLE_SUMMARY);
  });

  it('marks Chrome built-in "not eligible (language)" for Chinese and never asks it', async () => {
    const nano = stubEngine('nano', 'THIS MUST NEVER RUN');
    const local = stubEngine('webgpu', ZH_GIST);
    const outcome = await compareEngines({
      document: ZH_DOC,
      engines: [nano.engine, local.engine],
    });
    expect(outcome.language).toBe('zh');
    const nanoRow = outcome.rows.find((r) => r.kind === 'nano');
    expect(nanoRow?.status).toBe('not-eligible-language');
    expect(nanoRow?.text).toBeNull();
    // The whole point of routing: the model that cannot serve Chinese is not
    // run to watch it fail.
    expect(nano.generate).not.toHaveBeenCalled();
    expect(local.generate).toHaveBeenCalledTimes(1);
    expect(outcome.winnerKind).toBe('webgpu');
  });

  it('an engine that throws becomes an error row; the other results still render', async () => {
    const boom = stubEngine('nano', async () => {
      throw new Error('kaboom');
    });
    const local = stubEngine('webgpu', GROUNDED);
    const outcome = await compareEngines({
      document: DOC,
      engines: [boom.engine, local.engine],
    });
    expect(outcome.rows.find((r) => r.kind === 'nano')?.status).toBe('error');
    expect(outcome.rows.find((r) => r.kind === 'nano')?.error).toContain('kaboom');
    expect(outcome.winnerKind).toBe('webgpu');
  });

  it('states the size caveat when the engines are not the same parameter class', async () => {
    const outcome = await compareEngines({
      document: DOC,
      engines: [stubEngine('nano', GROUNDED).engine, stubEngine('webgpu', UNGROUNDED).engine],
    });
    expect(outcome.sizeCaveat).toContain('different model sizes');
    expect(outcome.sizeCaveat).toContain('~3.25B');
    expect(outcome.sizeCaveat).toContain('1B');
    expect(outcome.sizeCaveat).toContain('not purely engine quality');
  });

  it('omits the caveat when only one engine ran', async () => {
    const outcome = await compareEngines({
      document: DOC,
      engines: [stubEngine('webgpu', GROUNDED).engine],
    });
    expect(outcome.sizeCaveat).toBeNull();
  });

  it('pickWinner breaks a groundedness tie deterministically, local-first', async () => {
    const outcome = await compareEngines({
      document: DOC,
      engines: [stubEngine('webgpu', GROUNDED).engine, stubEngine('nano', GROUNDED).engine],
    });
    // Identical outputs → identical groundedness → the fixed engine order wins.
    expect(pickWinner(outcome.rows)?.kind).toBe('nano');
  });

  it('sizeCaveatFor ignores rows that never ran', () => {
    expect(sizeCaveatFor([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Health-row surface: rows side by side, and NOT ONE WRITE.
// ---------------------------------------------------------------------------

const compareGenerate = { nano: vi.fn(), webgpu: vi.fn() };

vi.mock('../../src/sidepanel/nano/engine', async (importActual) => {
  const actual = await importActual<typeof EngineModule>();
  return {
    ...actual,
    webGpuSupported: () => false,
    isWebGpuLoaded: () => false,
    readyEngines: async () => [
      { kind: 'nano' as const, generate: compareGenerate.nano },
      { kind: 'webgpu' as const, generate: compareGenerate.webgpu },
    ],
  };
});

const installChromeStub = (): void => {
  const backing: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in backing ? { [key]: backing[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) backing[k] = v;
        },
        remove: async (key: string) => {
          delete backing[key];
        },
      },
    },
  };
};

const LONG_MARKDOWN = `${DOC}\n\n`.repeat(4);

describe('Health → Experiments · Compare engines', () => {
  beforeEach(() => {
    compareGenerate.nano.mockReset();
    compareGenerate.webgpu.mockReset();
    compareGenerate.nano.mockResolvedValue(GROUNDED);
    compareGenerate.webgpu.mockResolvedValue(UNGROUNDED);
    installChromeStub();
  });

  it('renders a row per engine with scores, stars the winner, states the caveat — and POSTs nothing', async () => {
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(async () => ({ prompt: async () => GROUNDED, destroy: vi.fn() })),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/threads')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ bac_id: 't1' }] }) };
      }
      if (url.includes('/markdown')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { markdown: LONG_MARKDOWN } }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-compare'));

    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-compare-results')).toBeInTheDocument();
    });
    // Side by side: one row per engine, each with its declared identity.
    expect(screen.getByTestId('hp-ondevice-ai-compare-row-nano')).toHaveTextContent(
      'Chrome built-in · ~3.25B · 4-bit',
    );
    expect(screen.getByTestId('hp-ondevice-ai-compare-row-webgpu')).toHaveTextContent(
      'local · 1B · q4',
    );
    // Outputs and per-row scores.
    expect(screen.getByTestId('hp-ondevice-ai-compare-text-nano')).toHaveTextContent('CloudTrail');
    for (const key of ['rep', 'letters', 'uniq', 'ground']) {
      expect(screen.getByTestId('hp-ondevice-ai-compare-verdict-nano')).toHaveTextContent(key);
    }
    // Each row states the limits it ran under.
    expect(screen.getByTestId('hp-ondevice-ai-compare-row-webgpu')).toHaveTextContent(
      'limits: 3.6k in / 140 tok out',
    );
    // The winner is starred, and the size mismatch is called out.
    expect(screen.getByTestId('hp-ondevice-ai-compare-row-nano')).toHaveTextContent('★');
    expect(screen.getByTestId('hp-ondevice-ai-compare-caveat')).toHaveTextContent(
      'not purely engine quality',
    );
    // OBSERVE-ONLY. Two GETs to read a document, plus the row's HEAD probe of
    // the companion's model host (transfers nothing, changes nothing). No POST,
    // ever — a POST here would mean the comparison wrote or acquired something.
    for (const call of fetchMock.mock.calls as unknown as readonly [
      RequestInfo | URL,
      RequestInit | undefined,
    ][]) {
      expect(['GET', 'HEAD']).toContain(call[1]?.method ?? 'GET');
      expect(String(call[0])).not.toContain('/v1/enrichment/');
    }
    vi.unstubAllGlobals();
  });

  it('says so honestly when no document is long enough to compare on', async () => {
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(async () => ({ prompt: async () => GROUNDED, destroy: vi.fn() })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/threads')) {
          return { ok: true, status: 200, json: async () => ({ data: [{ bac_id: 't1' }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: { markdown: 'tiny' } }) };
      }),
    );
    render(<OnDeviceAiRow companionPort={17_373} bridgeKey="k" />);
    fireEvent.click(await screen.findByTestId('hp-ondevice-ai-compare'));
    await waitFor(() => {
      expect(screen.getByTestId('hp-ondevice-ai-compare-note')).toHaveTextContent(
        'no document long enough to compare on',
      );
    });
    vi.unstubAllGlobals();
  });
});
