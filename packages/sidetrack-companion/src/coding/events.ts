// Stage 4 — Class A event types produced by collector materializers.
//
// All collector materializers (test-tick, codex-cli, claude-code,
// future Stage 4.1 shell/git/github) promote into one of these
// canonical Class A types. The discriminator between source
// collectors is `producedBy.ruleId = "${collector_id}:${event_type}"`
// per Lock 3 (compass §2.D).
//
// Singleton-export pattern matches the rest of the codebase
// (threads/events.ts, dispatches/events.ts, …) so the registry
// coverage test (sync/contract/registry.test.ts) walks events.ts
// files and finds these constants.

export const CODING_TICK_OBSERVED = 'coding.tick.observed' as const;
export const CODING_SESSION_STARTED = 'coding.session.started' as const;
export const CODING_SESSION_TURN_OBSERVED = 'coding.session.turn.observed' as const;

export type CodingClassAEventType =
  | typeof CODING_TICK_OBSERVED
  | typeof CODING_SESSION_STARTED
  | typeof CODING_SESSION_TURN_OBSERVED;

export const CODING_CLASS_A_EVENT_TYPES: readonly CodingClassAEventType[] = [
  CODING_TICK_OBSERVED,
  CODING_SESSION_STARTED,
  CODING_SESSION_TURN_OBSERVED,
];
