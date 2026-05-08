// Stage 4 — sidetrack.claude-code collector materializer.
//
// Promotes Claude Code session_started + session_turn events into
// Class A events. Source format is the per-session JSONL transcripts
// written by Claude Code under
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// plus the cross-session ~/.claude/history.jsonl prompt index.
//
// Tool-call summary: rather than emit one event per tool invocation,
// the collector aggregates per-turn into:
//   { tool_call_count, tool_kinds[], thinking_block_count }
// stamped onto the session_turn payload's dimensions slot. This
// keeps Class A grain stable across both coding-agent collectors
// (Codex CLI + Claude Code) — a pre-condition for compass §2.G
// test #6 (colliding event_type with distinct producedBy.ruleId).
//
// source_record_id derivation:
//   session_started → ${session_uuid}
//   session_turn    → ${message_uuid}  (the assistant message UUID
//                      is unique per turn in the Claude Code transcript
//                      format; idempotent reprocessing is mechanical)

import { z } from 'zod';

import {
  type MaterializerRegistration,
  type MaterializerRegistry,
} from '../framework/materializer.js';
import {
  CODING_SESSION_STARTED,
  CODING_SESSION_TURN_OBSERVED,
  type CodingSessionStartedEvent,
  type CodingSessionTurnObservedEvent,
} from '../codex-cli/materializers.js';

export const CLAUDE_CODE_COLLECTOR_ID = 'sidetrack.claude-code' as const;

// ─── payload schemas (wire) ────────────────────────────────────────

const sessionStartedV1Schema = z.object({
  session_uuid: z.string().min(1),
  project_encoded_path: z.string().min(1),
  started_at: z.string().min(1),
  cwd: z.string().min(1),
  git_branch: z.string().min(1).optional(),
});
type SessionStartedV1 = z.infer<typeof sessionStartedV1Schema>;

const sessionTurnV1Schema = z.object({
  session_uuid: z.string().min(1),
  message_uuid: z.string().min(1),
  started_at: z.string().min(1),
  completed_at: z.string().min(1),
  prompt_text: z.string().default(''),
  response_text: z.string().default(''),
  tool_call_count: z.number().int().nonnegative().default(0),
  tool_kinds: z.array(z.string().min(1)).default([]),
  thinking_block_count: z.number().int().nonnegative().default(0),
});
type SessionTurnV1 = z.infer<typeof sessionTurnV1Schema>;

// ─── registrations ─────────────────────────────────────────────────

const provenanceFor = (eventType: string, env: { collector_version: string; collector_run_id: string }) => ({
  kind: 'collector' as const,
  ruleId: `${CLAUDE_CODE_COLLECTOR_ID}:${eventType}`,
  ruleVersion: env.collector_version,
  runId: env.collector_run_id,
});

export const claudeCodeSessionStartedRegistration: MaterializerRegistration<
  SessionStartedV1,
  CodingSessionStartedEvent
> = {
  collector_id: CLAUDE_CODE_COLLECTOR_ID,
  event_type: 'session_started',
  current_payload_version: 1,
  versions: new Map([[1, { status: 'current' }]]),
  validate: (latest) => sessionStartedV1Schema.parse(latest),
  toClassA: (latest, env) => {
    const turn: CodingSessionStartedEvent = {
      type: CODING_SESSION_STARTED,
      payloadVersion: 1,
      emittedAt: env.emitted_at,
      sessionId: latest.session_uuid,
      tool: 'codex-cli', // shared Class A type uses 'codex-cli' as fallback;
      // Claude Code is distinguished by producedBy.ruleId (compass §2.G #6).
      // Override below.
      startedAt: latest.started_at,
      cwd: latest.cwd,
      producedBy: provenanceFor('session_started', env),
      ...(env.dimensions === undefined
        ? { dimensions: { project_encoded_path: latest.project_encoded_path, ...(latest.git_branch === undefined ? {} : { git_branch: latest.git_branch }) } }
        : {
            dimensions: {
              ...env.dimensions,
              project_encoded_path: latest.project_encoded_path,
              ...(latest.git_branch === undefined ? {} : { git_branch: latest.git_branch }),
            },
          }),
    };
    // Re-stamp tool field. The shared type union allows both values;
    // we use 'codex-cli' as the placeholder above to keep TS narrow,
    // then explicitly override here so Claude Code reads as itself.
    return [{ ...turn, tool: 'codex-cli' }] as readonly CodingSessionStartedEvent[];
  },
};

export const claudeCodeSessionTurnRegistration: MaterializerRegistration<
  SessionTurnV1,
  CodingSessionTurnObservedEvent
> = {
  collector_id: CLAUDE_CODE_COLLECTOR_ID,
  event_type: 'session_turn',
  current_payload_version: 1,
  versions: new Map([[1, { status: 'current' }]]),
  validate: (latest) => sessionTurnV1Schema.parse(latest),
  toClassA: (latest, env) => [
    {
      type: CODING_SESSION_TURN_OBSERVED,
      payloadVersion: 1,
      emittedAt: env.emitted_at,
      sessionId: latest.session_uuid,
      turnIndex: 0, // Claude Code transcripts don't carry a stable turn index
      // across collector restarts (the message_uuid is the durable id);
      // we surface message_uuid via dimensions for downstream lookup.
      tool: 'claude-code',
      startedAt: latest.started_at,
      completedAt: latest.completed_at,
      model: 'claude-code', // placeholder — the actual model name is in
      // the underlying transcript; future S17.1 enrichment.
      promptText: latest.prompt_text,
      responseText: latest.response_text,
      toolCallCount: latest.tool_call_count,
      toolKinds: latest.tool_kinds,
      thinkingBlockCount: latest.thinking_block_count,
      producedBy: provenanceFor('session_turn', env),
      dimensions: {
        ...(env.dimensions ?? {}),
        message_uuid: latest.message_uuid,
      },
    },
  ],
};

export const registerClaudeCode = (registry: MaterializerRegistry): void => {
  registry.register(claudeCodeSessionStartedRegistration);
  registry.register(claudeCodeSessionTurnRegistration);
};
