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
  'sidetrack.threads.read_md',
  'sidetrack.workstreams.read_md',
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
