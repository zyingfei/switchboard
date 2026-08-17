// Prototype-lane status — read-only summary for the panel.
// docs/plans/2026-08-16-category-flexibility-hyde.md, UI-visibility phase
// (2026-08-16 follow-up: "very little visibility about how hyDE works").
//
// PURE presentation over data already computed by prototypeGeneration.ts /
// prototypeEvidence.ts — no new generation, no LLM call, no new numeric
// model. Combines three already-existing reads into one honest, human
// status per workstream:
//   (a) the latest generation BATCH for the workstream (folded from
//       WORKSTREAM_PROTOTYPE_GENERATED events — prototypeGeneration.ts's
//       own `foldLatestPrototypeGenerations`),
//   (b) the workstream's CURRENT evidence count + language (the SAME
//       `gatherWorkstreamEvidence` / `workstreamEvidenceLanguage` join
//       every other prototype-lane module already uses), and
//   (c) the Apple FM engine's live availability (`appleFmStatus`).
//
// When no prototypes exist yet, `whyNot` names the REAL reason — below the
// evidence floor, engine unavailable, or simply not generated yet — never a
// bare empty state. See prototypeGeneration.ts's `decideDirty` / `MIN_
// EVIDENCE_FOR_GENERATION` for the floor this mirrors (read-only; this
// module makes no generation decisions of its own).

import type { AppleServiceInfo } from '../enrichment/appleFmEngine.js';
import { appleFmUnavailableCopy } from '../enrichment/appleFmEngine.js';
import { MIN_EVIDENCE_FOR_GENERATION, type WorkstreamGenerationState } from './prototypeGeneration.js';

export interface WorkstreamPrototypeStatus {
  readonly workstreamId: string;
  readonly prototypeCount: number;
  /** Epoch ms of the last generation batch, or null when none exists yet. */
  readonly generatedAt: number | null;
  /** CURRENT evidence-item count (may differ from the count baked into
   *  `evidenceWatermark` if pages were filed/removed since generation). */
  readonly evidenceCount: number;
  readonly evidenceWatermark: string | null;
  /** Raw generator id, e.g. "apple-fm#reason=ok" or
   *  "evidence-selection#reason=zh" — always present when prototypes exist. */
  readonly engine: string | null;
  /** Human label for `engine`, e.g. "Apple Intelligence". */
  readonly engineLabel: string | null;
  readonly method: 'generated' | 'selected' | null;
  /** One human line explaining a 'selected' (non-generated) method — e.g.
   *  the zh-dominant real-excerpt fallback. Null for 'generated' batches. */
  readonly methodNote: string | null;
  /** Present ONLY when prototypeCount === 0 — the honest reason none exist. */
  readonly whyNot: string | null;
  /** Optional extra detail for whyNot (e.g. the specific engine-probe
   *  failure reason) — supplementary, never required to render whyNot. */
  readonly whyNotDetail: string | null;
}

const engineLabelFor = (generatorModelId: string): string => {
  if (generatorModelId.startsWith('apple-fm')) return 'Apple Intelligence';
  if (generatorModelId.startsWith('evidence-selection')) return 'real page excerpts (no generation)';
  return generatorModelId;
};

const methodNoteFor = (
  generatorModelId: string,
  method: 'generated' | 'selected',
): string | null => {
  if (method !== 'selected') return null;
  if (generatorModelId.includes('reason=zh') && !generatorModelId.includes('mixed')) {
    return 'Chinese-language pages: matching uses real excerpts instead of generated text';
  }
  if (generatorModelId.includes('mixed-en-zh')) {
    return 'Mixed-language pages: matching uses real excerpts instead of generated text';
  }
  return 'matching uses real excerpts instead of generated text';
};

/**
 * One workstream's honest status. `evidenceLanguageEn` is whether the
 * workstream's CURRENT evidence corpus would route to the Apple FM
 * generation path (`workstreamEvidenceLanguage(items) === 'en'`) — a
 * non-English corpus never needs the engine at all (it uses the ReDE-RF
 * selection fallback), so engine unavailability is only ever the reported
 * why-not for an English-dominant workstream.
 */
export const computeWorkstreamPrototypeStatus = (
  workstreamId: string,
  evidenceCount: number,
  evidenceLanguageEn: boolean,
  last: WorkstreamGenerationState | undefined,
  appleFm: Pick<AppleServiceInfo, 'available' | 'reason'> | undefined,
): WorkstreamPrototypeStatus => {
  if (last !== undefined) {
    return {
      workstreamId,
      prototypeCount: last.prototypeIds.length,
      generatedAt: last.generatedAt,
      evidenceCount,
      evidenceWatermark: last.evidenceWatermark,
      engine: last.generatorModelId,
      engineLabel: engineLabelFor(last.generatorModelId),
      method: last.method,
      methodNote: methodNoteFor(last.generatorModelId, last.method),
      whyNot: null,
      whyNotDetail: null,
    };
  }

  let whyNot: string;
  let whyNotDetail: string | null = null;
  if (evidenceCount < MIN_EVIDENCE_FOR_GENERATION) {
    whyNot = `needs ${String(MIN_EVIDENCE_FOR_GENERATION)}+ saved pages, has ${String(evidenceCount)}`;
  } else if (evidenceLanguageEn && appleFm?.available !== true) {
    whyNot = 'Apple Intelligence engine unavailable';
    whyNotDetail = appleFm === undefined ? null : appleFmUnavailableCopy(appleFm.reason);
  } else {
    whyNot = 'generation pending — runs in the background';
  }
  return {
    workstreamId,
    prototypeCount: 0,
    generatedAt: null,
    evidenceCount,
    evidenceWatermark: null,
    engine: null,
    engineLabel: null,
    method: null,
    methodNote: null,
    whyNot,
    whyNotDetail,
  };
};
