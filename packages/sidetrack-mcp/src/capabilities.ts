export const m1ReadToolNames = [
  'bac.recent_threads',
  'bac.workstream',
  'bac.context_pack',
  'bac.search',
  'bac.queued_items',
  'bac.inbound_reminders',
  'bac.coding_sessions',
  'bac.coding_session_register',
  'bac.dispatches',
  'bac.reviews',
  'bac.turns',
] as const;

export type M1ReadToolName = (typeof m1ReadToolNames)[number];

export const isM1ReadToolName = (value: string): value is M1ReadToolName =>
  m1ReadToolNames.some((toolName) => toolName === value);
