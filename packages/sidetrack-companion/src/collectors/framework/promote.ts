// Stage 4 — promotion choke point.
//
// `materializeCollectorLine(raw, ctx)` is the SINGLE place collector
// data crosses into Class A. Tests assert no other code path reaches
// `eventLog.appendServerObserved` from a collector source.
//
// Returns a PromotionResult describing what happened to the line:
//   - promoted   → caller (tail loop) should already have appended Class A
//                  events via the embedded `onPromote` callback; bookmark
//                  advance.
//   - deduped    → (collector_id, source_record_id) already promoted in a
//                  prior run; bookmark advance.
//   - quarantined → caller should append the raw line to the quarantine
//                   directory; bookmark advance.
//   - dropped    → reserved (unused in MVP).
//
// The function is pure with respect to its inputs except for the
// injected `onPromote` (which appends Class A events) and `isAlreadyPromoted`
// (which checks the dedup ledger).

import {
  MAX_RAW_LINE_BYTES,
  type CollectorEvent,
  type PromotionResult,
  type QuarantineReason,
} from './types.js';
import type { MaterializerRegistration, MaterializerRegistry } from './materializer.js';
import {
  type CollectorCapability,
  type GateState,
  gateStateForCollector,
} from './capabilityGates.js';

export interface PromoteContext {
  readonly registry: MaterializerRegistry;
  readonly isManifestLoaded: (collectorId: string) => boolean;
  readonly capabilitiesForCollector: (
    collectorId: string,
  ) => ReadonlyArray<CollectorCapability>;
  // Lock 4 — read gate state for any collector capability.
  // Receives the union of granted/revoked permission events; returns
  // 'granted' | 'revoked' | 'pending' for the (collector, capability)
  // pair.
  readonly gateStateFor: (
    collectorId: string,
    capability: CollectorCapability,
  ) => GateState;
  // (collector_id, source_record_id) presence check for idempotency.
  readonly isAlreadyPromoted: (
    collectorId: string,
    sourceRecordId: string,
  ) => Promise<{ original_class_a_id: string } | null>;
  // Append handler — receives the materializer's emitted Class A events
  // as opaque values (the materializer typed them; the framework just
  // forwards them).
  readonly onPromote: (
    line: CollectorEvent,
    events: readonly unknown[],
    ruleId: string,
  ) => Promise<void>;
}

const ENVELOPE_REQUIRED_KEYS: readonly (keyof CollectorEvent)[] = [
  'collector_id',
  'event_type',
  'payload_version',
  'emitted_at',
  'collector_version',
  'collector_run_id',
  'payload',
];

const isCollectorEventEnvelope = (value: unknown): value is CollectorEvent => {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['collector_id'] === 'string' &&
    typeof obj['event_type'] === 'string' &&
    typeof obj['payload_version'] === 'number' &&
    typeof obj['emitted_at'] === 'string' &&
    typeof obj['collector_version'] === 'string' &&
    typeof obj['collector_run_id'] === 'string' &&
    'payload' in obj &&
    (obj['source_record_id'] === undefined ||
      typeof obj['source_record_id'] === 'string') &&
    (obj['dimensions'] === undefined ||
      (typeof obj['dimensions'] === 'object' && obj['dimensions'] !== null))
  );
};

const quarantine = (line: CollectorEvent, reason: QuarantineReason): PromotionResult =>
  ({ kind: 'quarantined', reason, line }) as const;

// Walk the materializer's declared capability requirements and return
// the FIRST that's denied. If none is denied, return null.
const findDeniedCapability = (
  ctx: PromoteContext,
  collectorId: string,
): CollectorCapability | null => {
  for (const cap of ctx.capabilitiesForCollector(collectorId)) {
    if (ctx.gateStateFor(collectorId, cap) !== 'granted') return cap;
  }
  return null;
};

const runUpcasters = (
  payload: unknown,
  chain: ReadonlyArray<(x: unknown) => unknown>,
): { ok: true; upcasted: unknown } | { ok: false; reason: 'upcaster-threw' } => {
  let current = payload;
  for (const step of chain) {
    try {
      current = step(current);
    } catch {
      return { ok: false, reason: 'upcaster-threw' };
    }
  }
  return { ok: true, upcasted: current };
};

const runValidate = (
  reg: MaterializerRegistration<unknown>,
  upcasted: unknown,
):
  | { ok: true; validated: unknown }
  | { ok: false; reason: 'materializer-validation-failed' } => {
  try {
    return { ok: true, validated: reg.validate(upcasted) };
  } catch {
    return { ok: false, reason: 'materializer-validation-failed' };
  }
};

// Public — parse one raw JSONL line and run it through the choke point.
export const materializeCollectorLine = async (
  rawLine: string,
  ctx: PromoteContext,
): Promise<PromotionResult> => {
  // 0. Safety cap: drop oversized lines BEFORE JSON.parse to bound
  // parser-memory worst case. The line still goes to quarantine for
  // forensics; the audit subtype is collector:line-too-large.
  if (Buffer.byteLength(rawLine, 'utf8') > MAX_RAW_LINE_BYTES) {
    const placeholder: CollectorEvent = {
      collector_id: '<too-large>',
      event_type: '<too-large>',
      payload_version: 0,
      emitted_at: new Date(0).toISOString(),
      collector_version: '0.0.0',
      collector_run_id: '<too-large>',
      payload: rawLine.slice(0, 1024),
      dimensions: { byte_length: Buffer.byteLength(rawLine, 'utf8') },
    };
    return quarantine(placeholder, 'line-too-large');
  }

  // 1. Parse JSON envelope. Malformed → caller treats as "line-malformed"
  // and writes to quarantine via the never-drop policy.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    // We can't even build a CollectorEvent — return a synthetic
    // quarantine result with a placeholder line so the caller has
    // a uniform handling path.
    const placeholder: CollectorEvent = {
      collector_id: '<unparseable>',
      event_type: '<unparseable>',
      payload_version: 0,
      emitted_at: new Date(0).toISOString(),
      collector_version: '0.0.0',
      collector_run_id: '<unparseable>',
      payload: rawLine,
    };
    return quarantine(placeholder, 'materializer-validation-failed');
  }

  if (!isCollectorEventEnvelope(parsed)) {
    const placeholder: CollectorEvent = {
      collector_id: '<malformed>',
      event_type: '<malformed>',
      payload_version: 0,
      emitted_at: new Date(0).toISOString(),
      collector_version: '0.0.0',
      collector_run_id: '<malformed>',
      payload: parsed,
    };
    return quarantine(placeholder, 'materializer-validation-failed');
  }

  const line = parsed;

  // 2. Manifest loaded?
  if (!ctx.isManifestLoaded(line.collector_id)) {
    return quarantine(line, 'manifest-not-loaded');
  }

  // 3. Idempotent dedup on (collector_id, source_record_id).
  if (line.source_record_id !== undefined) {
    const prior = await ctx.isAlreadyPromoted(line.collector_id, line.source_record_id);
    if (prior !== null) {
      return { kind: 'deduped', original_class_a_id: prior.original_class_a_id };
    }
  }

  // 4. Privacy gate check.
  const denied = findDeniedCapability(ctx, line.collector_id);
  if (denied !== null) {
    return quarantine(line, 'privacy-gate-denied');
  }

  // 5. Materializer lookup.
  const lookup = ctx.registry.get(line.collector_id, line.event_type, line.payload_version);
  if (lookup.kind === 'not-registered') {
    // Could be unknown collector or unknown event type — both audit as
    // "unknown-event-type" per the never-drop policy. (The "unknown-
    // collector-id" reason is reserved for cases where the manifest
    // has been removed mid-run and the registry no longer recognizes
    // the collector at all.)
    return quarantine(line, 'unknown-event-type');
  }
  if (lookup.kind === 'version-too-new') {
    return quarantine(line, 'payload-version-too-new');
  }
  // status='quarantine-only' is a deliberate disabling — quarantine
  // without attempting promotion.
  if (lookup.status === 'quarantine-only') {
    return quarantine(line, 'manifest-not-loaded');
  }

  // 6. Upcast → validate → toClassA → append Class A.
  const upcastResult = runUpcasters(line.payload, lookup.upcasterChain);
  if (!upcastResult.ok) {
    return quarantine(line, upcastResult.reason);
  }

  const validateResult = runValidate(lookup.reg, upcastResult.upcasted);
  if (!validateResult.ok) {
    return quarantine(line, validateResult.reason);
  }

  const events = lookup.reg.toClassA(validateResult.validated, line);
  const ruleId = `${line.collector_id}:${line.event_type}`;
  await ctx.onPromote(line, events, ruleId);
  return { kind: 'promoted', events };
};
