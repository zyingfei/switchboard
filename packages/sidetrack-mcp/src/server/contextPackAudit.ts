// PRD §15 criterion 5 — the MISSING emit site.
//
// The freeze-lift table (PRD §15, amended 2026-07-11) names
// "≥1 MCP context-pack session" with the observable signal
// "`_BAC/audit/*.jsonl`: ≥1 `sidetrack.workstreams.context_pack` call
// via streamable-HTTP". The companion-side counter
// (section15Counters.ts:computeMcpContextPackSessions) filters audit
// lines for that tool name — but NOTHING ever wrote such a line:
//
//   - context_pack is a pure READ tool: it reads the vault snapshot and
//     returns Markdown, so it never flows through the companion's vault
//     writer / audit() closure.
//   - The companion only stamps an audit `tool` field for the 5
//     workstream WRITE tools (auth/workstreamTrust.ts), and only inside
//     runWithAuditContext — which GET requests skip (server.ts).
//
// So the counter read 0 forever and permanently blocked
// freezeLiftEligible. This module is that emit site: when the
// streamable-HTTP MCP server serves a context_pack call, it appends a
// single audit line to the SAME `_BAC/audit/<YYYY-MM-DD>.jsonl` log the
// companion writes, with `tool` set to the context_pack tool id, so the
// counter can observe it.
//
// FREEZE-SAFE (ADR-0011): pure observability. The only artifact written
// is an audit-log line; no recall/ranker/connections/attribution serving
// consumer reads it. The line's shape is a strict subset of the
// companion's audit schema (auditEventSchema), so the companion's audit
// reader and the §15 collector parse it without change.

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// The tool id the §15 counter matches. Kept in lockstep with the tool
// registered in mcpServer.ts and the companion's
// MCP_CONTEXT_PACK_TOOL (section15Counters.ts).
export const MCP_CONTEXT_PACK_TOOL = 'sidetrack.workstreams.context_pack';

// One context_pack invocation, as the collector will see it. The sink
// receives only redaction-safe fields — never the pack Markdown, the
// workstream contents, or a full request payload.
export interface ContextPackAuditRecord {
  // The workstream the pack was scoped to, or null for a whole-vault
  // pack. Recorded as the audit `scope` (matches the companion's
  // per-workstream scope field).
  readonly workstreamId: string | null;
}

// The seam the context_pack tool handler calls. Best-effort by
// contract: the handler ignores rejections so an audit-write failure can
// never fail the read. Optional at the server factory so stdio / test
// wiring that has no vault-write surface simply omits it.
export type ContextPackAuditSink = (record: ContextPackAuditRecord) => Promise<void>;

// Build the on-disk sink. `agent` is the caller-class label the
// companion uses ('mcp:<client-name>' | 'mcp'); it defaults to 'mcp'
// so a line is always self-describing. `now` is injectable for tests.
export const createFileContextPackAuditSink = (options: {
  readonly vaultRoot: string;
  readonly agent?: string;
  readonly now?: () => Date;
}): ContextPackAuditSink => {
  const now = options.now ?? (() => new Date());
  const agent = options.agent ?? 'mcp';
  const auditRoot = resolve(options.vaultRoot, '_BAC', 'audit');
  return async (record) => {
    const timestamp = now().toISOString();
    // A strict subset of the companion's auditEventSchema: required
    // requestId/route/outcome/timestamp plus the provenance fields the
    // §15 collector reads. `tool` is the load-bearing field.
    const line = {
      requestId: randomUUID(),
      route: 'mcp.workstreams.context_pack',
      outcome: 'success' as const,
      timestamp,
      agent,
      tool: MCP_CONTEXT_PACK_TOOL,
      argsSummary: 'streamable-http context_pack',
      scope: record.workstreamId,
      trustModeActive: false,
    };
    const auditPath = join(auditRoot, `${timestamp.slice(0, 10)}.jsonl`);
    // Best-effort: never let an audit-write failure surface to the read
    // (mirrors the companion's appendHttpAuditLine catch-all).
    await mkdir(auditRoot, { recursive: true }).catch(() => undefined);
    await appendFile(auditPath, `${JSON.stringify(line)}\n`, 'utf8').catch(() => undefined);
  };
};
