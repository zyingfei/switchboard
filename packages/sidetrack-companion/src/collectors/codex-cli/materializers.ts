// Stage 4 — sidetrack.codex-cli collector materializer.
//
// Promotes Codex CLI session_started + session_turn events into Class
// A events. Source format is the OpenAI Codex CLI rollout JSONL files
// at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl plus the cross-
// session ~/.codex/history.jsonl.
//
// The collector binary (out of scope for this PR — separate repo)
// tails those rollout files and writes CollectorEvent JSONL into
// _BAC/inbox/sidetrack.codex-cli/<date>.jsonl. This module is the
// companion-side materializer that consumes those promoted lines.
//
// source_record_id derivation:
//   session_started → ${session_id}
//   session_turn    → ${session_id}:${turn_index}
// Both are stable across collector restarts.

import { z } from 'zod';

import {
  type MaterializerRegistration,
  type MaterializerRegistry,
} from '../framework/materializer.js';

export const CODEX_CLI_COLLECTOR_ID = 'sidetrack.codex-cli' as const;

// Class A event types produced. Both new for Stage 4; ContractEntry
// rows added in src/sync/contract/registry.ts as part of L1 / S15
// integration.
export const CODING_SESSION_STARTED = 'coding.session.started' as const;
export const CODING_SESSION_TURN_OBSERVED = 'coding.session.turn.observed' as const;

// ─── payload schemas (wire) ────────────────────────────────────────

const sessionStartedV1Schema = z.object({
  session_id: z.string().min(1),
  started_at: z.string().min(1),
  cwd: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
type SessionStartedV1 = z.infer<typeof sessionStartedV1Schema>;

const sessionTurnV1Schema = z.object({
  session_id: z.string().min(1),
  turn_index: z.number().int().nonnegative(),
  started_at: z.string().min(1),
  completed_at: z.string().min(1),
  model: z.string().min(1),
  prompt_text: z.string().default(''),
  response_text: z.string().default(''),
  tool_call_count: z.number().int().nonnegative().default(0),
  exec_command_count: z.number().int().nonnegative().default(0),
});
type SessionTurnV1 = z.infer<typeof sessionTurnV1Schema>;

// ─── promoted Class A event shapes ─────────────────────────────────

interface CollectorProvenance {
  readonly kind: 'collector';
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly runId: string;
}

export interface CodingSessionStartedEvent {
  readonly type: typeof CODING_SESSION_STARTED;
  readonly payloadVersion: 1;
  readonly emittedAt: string;
  readonly sessionId: string;
  readonly tool: 'codex-cli';
  readonly startedAt: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly producedBy: CollectorProvenance;
  readonly dimensions?: Record<string, unknown>;
}

export interface CodingSessionTurnObservedEvent {
  readonly type: typeof CODING_SESSION_TURN_OBSERVED;
  readonly payloadVersion: 1;
  readonly emittedAt: string;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly tool: 'codex-cli' | 'claude-code';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly model: string;
  readonly promptText: string;
  readonly responseText: string;
  readonly toolCallCount: number;
  readonly execCommandCount?: number;
  readonly toolKinds?: readonly string[];
  readonly thinkingBlockCount?: number;
  readonly producedBy: CollectorProvenance;
  readonly dimensions?: Record<string, unknown>;
}

// ─── registrations ─────────────────────────────────────────────────

const provenanceFor = (
  collectorId: string,
  eventType: string,
  envCollectorVersion: string,
  envRunId: string,
): CollectorProvenance => ({
  kind: 'collector',
  ruleId: `${collectorId}:${eventType}`,
  ruleVersion: envCollectorVersion,
  runId: envRunId,
});

export const codexCliSessionStartedRegistration: MaterializerRegistration<
  SessionStartedV1,
  CodingSessionStartedEvent
> = {
  collector_id: CODEX_CLI_COLLECTOR_ID,
  event_type: 'session_started',
  current_payload_version: 1,
  versions: new Map([[1, { status: 'current' }]]),
  validate: (latest) => sessionStartedV1Schema.parse(latest),
  toClassA: (latest, env) => [
    {
      type: CODING_SESSION_STARTED,
      payloadVersion: 1,
      emittedAt: env.emitted_at,
      sessionId: latest.session_id,
      tool: 'codex-cli',
      startedAt: latest.started_at,
      ...(latest.cwd === undefined ? {} : { cwd: latest.cwd }),
      ...(latest.model === undefined ? {} : { model: latest.model }),
      producedBy: provenanceFor(
        CODEX_CLI_COLLECTOR_ID,
        'session_started',
        env.collector_version,
        env.collector_run_id,
      ),
      ...(env.dimensions === undefined ? {} : { dimensions: env.dimensions }),
    },
  ],
};

export const codexCliSessionTurnRegistration: MaterializerRegistration<
  SessionTurnV1,
  CodingSessionTurnObservedEvent
> = {
  collector_id: CODEX_CLI_COLLECTOR_ID,
  event_type: 'session_turn',
  current_payload_version: 1,
  versions: new Map([[1, { status: 'current' }]]),
  validate: (latest) => sessionTurnV1Schema.parse(latest),
  toClassA: (latest, env) => [
    {
      type: CODING_SESSION_TURN_OBSERVED,
      payloadVersion: 1,
      emittedAt: env.emitted_at,
      sessionId: latest.session_id,
      turnIndex: latest.turn_index,
      tool: 'codex-cli',
      startedAt: latest.started_at,
      completedAt: latest.completed_at,
      model: latest.model,
      promptText: latest.prompt_text,
      responseText: latest.response_text,
      toolCallCount: latest.tool_call_count,
      execCommandCount: latest.exec_command_count,
      producedBy: provenanceFor(
        CODEX_CLI_COLLECTOR_ID,
        'session_turn',
        env.collector_version,
        env.collector_run_id,
      ),
      ...(env.dimensions === undefined ? {} : { dimensions: env.dimensions }),
    },
  ],
};

export const registerCodexCli = (registry: MaterializerRegistry): void => {
  registry.register(codexCliSessionStartedRegistration);
  registry.register(codexCliSessionTurnRegistration);
};
