// Order matches the server.registerTool() calls in mcpServer.ts so
// that a `tools/list` response matches this list verbatim — the
// stdio test asserts on it.
export const sidetrackToolNames = [
  'sidetrack.dispatch.create',
  'sidetrack.dispatch.await_capture',
  'sidetrack.session.attach',
  'sidetrack.annotations.create_batch',
  'sidetrack.threads.list',
  'sidetrack.workstreams.get',
  'sidetrack.workstreams.context_pack',
  'sidetrack.search',
  'sidetrack.queue.list',
  'sidetrack.reminders.list',
  'sidetrack.sessions.list',
  'sidetrack.threads.move',
  'sidetrack.queue.create',
  'sidetrack.workstreams.bump',
  'sidetrack.threads.archive',
  'sidetrack.threads.unarchive',
  'sidetrack.audit.list',
  'sidetrack.workstreams.notes',
  'sidetrack.annotations.list',
  'sidetrack.annotations.update',
  'sidetrack.annotations.delete',
  'sidetrack.recall.query',
  'sidetrack.suggestions.workstream',
  'sidetrack.settings.export',
  'sidetrack.system.update_check',
  'sidetrack.buckets.list',
  'sidetrack.system.health',
  'sidetrack.dispatches.list',
  'sidetrack.reviews.list',
  'sidetrack.threads.turns',
] as const;

export type SidetrackToolName = (typeof sidetrackToolNames)[number];

export const isSidetrackToolName = (value: string): value is SidetrackToolName =>
  sidetrackToolNames.some((toolName) => toolName === value);

// MCP prompts (Phase 5). Order matches the registerPrompt() calls in
// prompts.ts; the tooling-test asserts on it. Three workflows: a
// 3-line attach prompt, a full demo dispatch+annotate flow, and an
// annotate-only flow against an already-captured thread.
export const sidetrackPromptNames = [
  'sidetrack.session.attach',
  'sidetrack.demo.dispatch_and_annotate',
  'sidetrack.thread.annotate',
] as const;

export type SidetrackPromptName = (typeof sidetrackPromptNames)[number];

// MCP resource templates (Phase 5). Each is a sidetrack:// URI
// pattern advertised via resources/list. The order mirrors
// registerResource() calls in resources.ts.
export const sidetrackResourceTemplates = [
  'sidetrack://thread/{threadId}',
  'sidetrack://thread/{threadId}/turns',
  'sidetrack://thread/{threadId}/annotations',
  'sidetrack://thread/{threadId}/markdown',
  'sidetrack://dispatch/{dispatchId}',
  'sidetrack://workstream/{workstreamId}/context',
] as const;

export type SidetrackResourceTemplate = (typeof sidetrackResourceTemplates)[number];
