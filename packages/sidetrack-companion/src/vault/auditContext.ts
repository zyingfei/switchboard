import { AsyncLocalStorage } from 'node:async_hooks';

// F02 — request-scoped audit provenance.
//
// Audit lines are written deep inside the vault writer (writer.ts), which
// only knows the `requestId`. The caller-identity facts we want on every
// MCP-write audit line — which agent authenticated, which MCP tool drove
// the write, whether workstream-trust enforcement was active — are derived
// in the HTTP layer (server.ts) at request time. Rather than thread five
// extra parameters through every VaultWriter method, the HTTP handler runs
// the request body inside `runWithAuditContext`, and the writer's `audit()`
// closure reads the ambient context via `currentAuditContext`.
//
// AsyncLocalStorage keeps the context correctly bound across the awaited
// writer calls within a single request without leaking between concurrent
// requests. The stored value is MUTABLE on purpose: the handler binds a
// base context (agent + argsSummary, no tool/scope yet), and the trust
// gate — which runs mid-request and is the authority on which tool and
// workstream scope apply — refines the same object in place. Single-
// threaded per async context, so the mutation is race-free.
//
// When no context is bound (e.g. a legacy call path or a unit test that
// exercises the writer directly), the writer simply omits the provenance
// fields — the audit line stays valid, just sparser.

export interface AuditContext {
  // Caller class. 'extension' for the user's own bridge-key surface;
  // 'mcp:<client-name>' for an MCP-key authenticated agent.
  agent: string;
  // The MCP write tool that drove the request, or null for direct
  // (non-tool) writes such as the extension's own CRUD calls.
  tool: string | null;
  // Bounded, redaction-safe description of the call. Never the full payload.
  argsSummary?: string;
  // Workstream id the write was trust-scoped to, or null when not scoped.
  scope: string | null;
  // Whether workstream-trust enforcement gated this call (true for
  // MCP-key callers subject to the opt-in trust gate).
  trustModeActive: boolean;
}

const storage = new AsyncLocalStorage<AuditContext>();

export const runWithAuditContext = <T>(context: AuditContext, run: () => T): T =>
  storage.run(context, run);

export const currentAuditContext = (): AuditContext | undefined => storage.getStore();

// Bound the argsSummary so a chatty caller can never bloat the audit
// line or smuggle a full payload past the "no full payloads" rule.
export const boundArgsSummary = (summary: string): string =>
  summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
