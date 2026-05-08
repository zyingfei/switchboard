// Stage 4 — collector audit subtype namespace.
//
// The companion's existing audit log writes JSONL entries with an
// open-ended `route` string (see vault/writer.ts). Stage 4 reserves
// the `collector:` prefix for collector-related decisions; no schema
// migration in `vault/auditRetention.ts` is needed because the
// retention policy is route-agnostic.
//
// Every byte read by the companion that started life as a collector
// JSONL line ends in exactly one of: a `collector:line-promoted`
// audit (Class A append happened), a `collector:line-quarantined`
// audit (durable append to _BAC/audit/quarantine/), or a
// `collector:line-malformed` audit (line failed CollectorEvent
// shape; preserved on disk but bookmark advanced). This invariant is
// the test surface for compass §2.D.

export const COLLECTOR_AUDIT_ROUTES = {
  // Inbox tail loop reading.
  LINE_READ: 'collector:line-read',
  LINE_MALFORMED: 'collector:line-malformed',
  LINE_PROMOTED: 'collector:line-promoted',
  LINE_QUARANTINED: 'collector:line-quarantined',
  LINE_DEDUPED: 'collector:line-deduped',
  BOOKMARK_ADVANCED: 'collector:bookmark-advanced',
  // Manifest discovery + load decision.
  MANIFEST_LOADED: 'collector:manifest-loaded',
  MANIFEST_RELOADED: 'collector:manifest-reloaded',
  MANIFEST_TOO_NEW: 'collector:manifest-too-new',
  MANIFEST_TOO_OLD: 'collector:manifest-too-old',
  MANIFEST_REQUIRES_COMPANION_NOT_SATISFIED:
    'collector:manifest-requires-companion-not-satisfied',
  MANIFEST_REQUIRES_VAULT_NOT_SATISFIED:
    'collector:manifest-requires-vault-not-satisfied',
  MANIFEST_NO_EMITS_REGISTERED: 'collector:manifest-no-emits-registered',
  MANIFEST_SPAWN_POLICY_UNSUPPORTED:
    'collector:manifest-spawn-policy-unsupported',
  MANIFEST_PARSE_FAILED: 'collector:manifest-parse-failed',
  MANIFEST_SCHEMA_FAILED: 'collector:manifest-schema-failed',
  // Replay-on-startup.
  REPLAY_STARTED: 'collector:replay-started',
  REPLAY_COMPLETED: 'collector:replay-completed',
} as const;

export type CollectorAuditRoute =
  (typeof COLLECTOR_AUDIT_ROUTES)[keyof typeof COLLECTOR_AUDIT_ROUTES];

export const isCollectorAuditRoute = (route: string): route is CollectorAuditRoute =>
  Object.values(COLLECTOR_AUDIT_ROUTES).includes(route as CollectorAuditRoute);
