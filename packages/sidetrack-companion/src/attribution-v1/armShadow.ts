// Attribution arm — reverse-direction shadow counter (M6).
//
// When serving the vote3 arm, we ALSO compute the incumbent graph-resolver's
// answer per resolve and record whether the two AGREE. This is the reverse of
// the M1 shadow lane (which runs the challenger beside the incumbent while the
// incumbent serves): here the CHALLENGER serves and the incumbent shadows it,
// the safety net that tells us post-flip whether the served arm and the retired
// resolver diverge. A low agree-rate with the demo suddenly lighting up is the
// EXPECTED signal, not an alarm — the incumbent abstained 86% of the time, so
// disagreement is the point; we watch it for weeks-scale drift regardless.
//
// COST DISCIPLINE (mirrors shadow.ts): the counter is an in-process O(1) tally,
// no serve-path I/O. The drain hook reads the snapshot and folds it into the
// health/diagnostics artifact, then the counter keeps accumulating (it is a
// lifetime running total surfaced as {requests, agreeRate}, not a per-drain
// ring buffer — a monotone health gauge).
//
// SURFACE (intentional): this is a drain-flushed VAULT-FILE gauge
// (_BAC/system/attribution-arm-shadow.json), NOT a /v1/system/health API field.
// This deliberately matches the precedent of its closest mirror — the M1
// attribution-v1 shadow (shadow.ts), which likewise writes
// _BAC/system/attribution-v1-shadow.jsonl and is not surfaced in
// /v1/system/health. An operator watching the post-flip agreeRate reads the
// vault file (or the drain diagnostics), the same read-back the task's
// "drain diagnostics/health" requirement names. Folding it into the health
// endpoint's large response shape was considered and declined to keep the
// change surface tight; flip this if the health API grows a shadow section.

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ArmShadowSnapshot {
  readonly requests: number;
  readonly agreeRate: number;
}

let requests = 0;
let agrees = 0;

// Record one served-vote3-vs-incumbent comparison. `agree` is the honest
// definition: both name the same non-null workstream, OR both abstain. O(1),
// safe on the serve path.
export const recordArmShadow = (agree: boolean): void => {
  requests += 1;
  if (agree) agrees += 1;
};

// The current running snapshot for the drain diagnostics/health artifact.
export const armShadowSnapshot = (): ArmShadowSnapshot => ({
  requests,
  agreeRate: requests === 0 ? 0 : agrees / requests,
});

export const resetArmShadowForTest = (): void => {
  requests = 0;
  agrees = 0;
};

// Sibling of the v1 shadow log under system/. A tiny JSON gauge (not a growing
// log) rewritten atomically each drain — the {requests, agreeRate} health
// readout the reverse-shadow surfaces for weeks-scale drift watching.
const ARM_SHADOW_ARTIFACT_RELATIVE_PATH = '_BAC/system/attribution-arm-shadow.json';

export const attributionArmShadowArtifactPath = (vaultRoot: string): string =>
  join(vaultRoot, ARM_SHADOW_ARTIFACT_RELATIVE_PATH);

// Drain-time flush: write the current armShadow snapshot to the gauge artifact.
// Best-effort (the caller swallows failures — observability must never fail a
// drain). Returns the snapshot written (or null when there were no requests, so
// an idle companion doesn't churn the file).
export const flushArmShadow = async (
  vaultRoot: string,
  now: () => Date = () => new Date(),
): Promise<ArmShadowSnapshot | null> => {
  const snapshot = armShadowSnapshot();
  if (snapshot.requests === 0) return null;
  const path = attributionArmShadowArtifactPath(vaultRoot);
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(
    { generatedAt: now().toISOString(), armShadow: snapshot },
    null,
    2,
  )}\n`;
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
  return snapshot;
};
