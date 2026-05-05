// Renamed from m1ReadToolNames now that write tools (move_item,
// queue_item) live in the same set. Order matches the
// server.registerTool() calls in mcpServer.ts so that a `tools/list`
// response matches this list verbatim — the stdio test asserts on it.
export const sidetrackToolNames = [
  'bac.recent_threads',
  'bac.workstream',
  'bac.context_pack',
  'bac.search',
  'bac.queued_items',
  'bac.inbound_reminders',
  'bac.coding_sessions',
  'bac.coding_session_register',
  'bac.request_dispatch',
  'bac.move_item',
  'bac.queue_item',
  'bac.bump_workstream',
  'bac.archive_thread',
  'bac.unarchive_thread',
  'bac.list_dispatches',
  'bac.list_audit_events',
  'bac.list_workstream_notes',
  'bac.create_annotation',
  'bac.list_annotations',
  'bac.update_annotation',
  'bac.delete_annotation',
  'bac.read_thread_md',
  'bac.read_workstream_md',
  'bac.recall',
  'bac.suggest_workstream',
  'bac.export_settings',
  'bac.system_update_check',
  'bac.list_buckets',
  'bac.system_health',
  'bac.dispatches',
  'bac.reviews',
  'bac.turns',
] as const;

// Backwards-compatible alias — older callers (tests, CLI) still
// import m1ReadToolNames. Will retire once everything moves to the
// new name.
export const m1ReadToolNames = sidetrackToolNames;

export type SidetrackToolName = (typeof sidetrackToolNames)[number];
export type M1ReadToolName = SidetrackToolName;

export const isSidetrackToolName = (value: string): value is SidetrackToolName =>
  sidetrackToolNames.some((toolName) => toolName === value);

export const isM1ReadToolName = isSidetrackToolName;
