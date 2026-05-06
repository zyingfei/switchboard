// Order matches the server.registerTool() calls in mcpServer.ts so
// that a `tools/list` response matches this list verbatim — the
// stdio test asserts on it.
//
// Sub-commits within the spec-alignment refactor land in passes:
//   1.1 (this commit)  — sidetrack.dispatch.{create,await_capture} added
//                        ahead of the legacy `bac.*` entries.
//   1.2 / 1.3          — sidetrack.session.attach + sidetrack.annotations.create_batch.
//   1.4                — mass rename of the remaining `bac.*` to
//                        `sidetrack.*` and deletion of the now-superseded
//                        request_dispatch / coding_session_register /
//                        create_annotation entries.
export const sidetrackToolNames = [
  'sidetrack.dispatch.create',
  'sidetrack.dispatch.await_capture',
  'sidetrack.session.attach',
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
