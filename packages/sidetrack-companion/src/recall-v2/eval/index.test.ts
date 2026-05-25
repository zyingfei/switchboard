// Recall v2 — eval gate (vitest project).
//
// Runs all 11 golden fixtures through the recall pipeline. Each
// fixture's `assertions` block is the TARGET behavior (what we want
// after the full v2 stack lands); the eval ALSO compares against a
// baseline.json snapshot — the gate only fails when a metric REGRESSES
// vs the recorded baseline. Each phase that improves ranking
// regenerates baseline.json and tightens targets.
//
// To regenerate the baseline (after intentional ranking changes):
//   RECALL_EVAL_UPDATE_BASELINE=1 bun run --cwd packages/sidetrack-companion eval:recall
//
// Prints a metric table per fixture to stdout for easy comparison.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatReport, runFixture, type Fixture, type FixtureReport } from './harness.js';

import { fixture as hnClaudeArchitect } from './fixtures/hn-claude-architect.js';
import { fixture as mlAttentionMechanisms } from './fixtures/ml-attention-mechanisms.js';
import { fixture as cveMemoryCorruption } from './fixtures/cve-memory-corruption.js';
import { fixture as networkBgpFabrics } from './fixtures/network-bgp-fabrics.js';
import { fixture as chatSelfLoop } from './fixtures/chat-self-loop.js';
import { fixture as shortVisitNoExtract } from './fixtures/short-visit-no-extract.js';
import { fixture as cjkSelection } from './fixtures/cjk-selection.js';
import { fixture as rareTermRescue } from './fixtures/rare-term-rescue.js';
import { fixture as multilingualMixed } from './fixtures/multilingual-mixed.js';
import { fixture as timeDecay } from './fixtures/time-decay.js';
import { fixture as sourceDiversity } from './fixtures/source-diversity.js';
import { fixture as askAiArtifactSuppression } from './fixtures/ask-ai-artifact-suppression.js';

const FIXTURES: readonly Fixture[] = [
  hnClaudeArchitect,
  mlAttentionMechanisms,
  cveMemoryCorruption,
  networkBgpFabrics,
  chatSelfLoop,
  shortVisitNoExtract,
  cjkSelection,
  rareTermRescue,
  multilingualMixed,
  timeDecay,
  sourceDiversity,
  askAiArtifactSuppression,
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'baseline.json');
const UPDATE_BASELINE = process.env['RECALL_EVAL_UPDATE_BASELINE'] === '1';

type MetricKey = keyof FixtureReport['metrics'];
const HIGHER_IS_BETTER: ReadonlySet<MetricKey> = new Set<MetricKey>([
  'recallAt5',
  'recallAt10',
  'recallAt20',
  'mrr',
  'ndcgAt10',
  'sourceDiversityAt5',
]);
const LOWER_IS_BETTER: ReadonlySet<MetricKey> = new Set<MetricKey>([
  'selfHitAt10',
  'forbiddenHitAt5',
  'duplicateRateAt10',
]);
// latencyP50Ms/P95Ms tracked but not gated (depends on machine load)

const SLACK_HIGHER = 0.01; // metrics may dip 0.01 below baseline without failing
const SLACK_LOWER = 0.01; // metrics may climb 0.01 above baseline without failing

type Baseline = Record<string, FixtureReport['metrics']>;

const loadBaseline = async (): Promise<Baseline> => {
  try {
    const raw = await readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(raw) as Baseline;
  } catch {
    return {};
  }
};

const compareToBaseline = (
  current: FixtureReport['metrics'],
  baseline: FixtureReport['metrics'] | undefined,
): string[] => {
  if (baseline === undefined) return []; // first run — establish baseline next save
  const failures: string[] = [];
  for (const k of HIGHER_IS_BETTER) {
    const cur = current[k];
    const base = baseline[k];
    if (cur < base - SLACK_HIGHER) {
      failures.push(`${k} regressed: ${cur.toFixed(3)} < ${base.toFixed(3)} - ${SLACK_HIGHER}`);
    }
  }
  for (const k of LOWER_IS_BETTER) {
    const cur = current[k];
    const base = baseline[k];
    if (cur > base + SLACK_LOWER) {
      failures.push(`${k} regressed: ${cur.toFixed(3)} > ${base.toFixed(3)} + ${SLACK_LOWER}`);
    }
  }
  return failures;
};

// Quality metrics that must NOT regress vs baseline. Failure here →
// gate fails (unless the fixture is xfail).
const QUALITY_RATCHET: ReadonlySet<MetricKey> = new Set<MetricKey>([
  'recallAt5',
  'recallAt10',
  'mrr',
  'ndcgAt10',
]);

// Baseline-zero sanity: a metric with baseline=0 in QUALITY_RATCHET
// (R@5=0, MRR=0, nDCG=0) means we previously locked in a broken state.
// Block the gate unless the fixture explicitly marks itself xfail OR
// opts out via skipRecallChecks. Catches the source-diversity case
// where R@5=0 was passing silently.
const baselineZeroBlocker = (
  fixtureName: string,
  baseline: FixtureReport['metrics'] | undefined,
  isXfail: boolean,
  skipsRecall: boolean,
): string | null => {
  if (baseline === undefined) return null;
  if (isXfail || skipsRecall) return null;
  if (baseline.recallAt5 === 0 && baseline.mrr === 0 && baseline.ndcgAt10 === 0) {
    return `${fixtureName}: baseline has R@5=0/MRR=0/nDCG=0 — quality is broken at the recorded floor. Fix the fixture, add skipRecallChecks (if it tests a non-recall axis), or mark xfail with a reason.`;
  }
  return null;
};

describe('Recall v2 — eval gate', () => {
  // Sequential so per-fixture timings aren't perturbed by parallel I/O.
  const collected = new Map<string, FixtureReport>();

  for (const f of FIXTURES) {
    it(`${f.name}: ${f.description}`, async () => {
      const baseline = await loadBaseline();
      const report = await runFixture(f);
      collected.set(f.name, report);
      // eslint-disable-next-line no-console -- intentional metric table output
      console.log(formatReport(report));

      const isXfail = report.xfail !== undefined;
      if (isXfail) {
        // eslint-disable-next-line no-console
        console.warn(
          `  XFAIL [${report.xfail!.trackedAs ?? 'no-ticket'}]: ${report.xfail!.reason}`,
        );
      }

      // (1) INVARIANTS — always enforced; xfail does NOT bypass these.
      if (report.invariantFailures.length > 0) {
        throw new Error(
          `${f.name} INVARIANT failure (always-enforced): ${report.invariantFailures.join('; ')}`,
        );
      }

      // (2) Target ratchet failures — fail unless xfail.
      if (report.ratchetFailures.length > 0) {
        if (isXfail) {
          // eslint-disable-next-line no-console
          console.warn(`  TARGETS NOT MET (xfail): ${report.ratchetFailures.join('; ')}`);
        } else if (!UPDATE_BASELINE) {
          throw new Error(`${f.name} TARGET failure: ${report.ratchetFailures.join('; ')}`);
        }
      }

      // (3) Baseline-zero sanity — a baseline of 0 on quality metrics
      //     is a broken floor; never silently accept it.
      const zeroBlocker = baselineZeroBlocker(
        f.name,
        baseline[f.name],
        isXfail,
        f.assertions.skipRecallChecks === true,
      );
      if (zeroBlocker !== null) {
        throw new Error(zeroBlocker);
      }

      // (4) Baseline ratchet — quality metrics cannot regress.
      const regressions = compareToBaseline(report.metrics, baseline[f.name]);
      if (regressions.length === 0) return;
      const ratchetRegressions = regressions.filter((r) =>
        Array.from(QUALITY_RATCHET).some((k) => r.startsWith(k)),
      );
      const invariantRegressions = regressions.filter((r) => !ratchetRegressions.includes(r));

      if (invariantRegressions.length > 0 && !UPDATE_BASELINE) {
        throw new Error(
          `${f.name} INVARIANT regression vs baseline: ${invariantRegressions.join('; ')}`,
        );
      }
      if (ratchetRegressions.length > 0 && !UPDATE_BASELINE && !isXfail) {
        throw new Error(
          `${f.name} QUALITY regression vs baseline: ${ratchetRegressions.join('; ')}`,
        );
      }
      if (ratchetRegressions.length > 0 && isXfail) {
        // eslint-disable-next-line no-console
        console.warn(
          `  RATCHET regression accepted (xfail): ${ratchetRegressions.join('; ')}`,
        );
      }
    });
  }

  it('updates baseline.json when invoked with RECALL_EVAL_UPDATE_BASELINE=1', async () => {
    if (!UPDATE_BASELINE) return; // no-op unless explicitly requested
    const baseline: Baseline = {};
    for (const [name, report] of collected) {
      baseline[name] = report.metrics;
    }
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Wrote baseline for ${String(collected.size)} fixtures to ${BASELINE_PATH}`);
  });
});
