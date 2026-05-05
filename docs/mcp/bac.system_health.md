# bac.system_health

Read tool. Returns companion diagnostic health: uptime, vault status, capture
hints, recall index summary, and service status. Sub-collectors are best-effort
and budgeted so the endpoint stays responsive.

Newer companions may also return optional live diagnostics:

- `capture.providers[]` with per-provider last capture, selector-canary state,
  and 24h ok/warn/fail counts
- `capture.recentWarnings[]` from recent capture event warnings
- `recall.activity.recent[]` with incremental index, rebuild, recall-query, and
  group-recommendation events from the current companion process
- `recall.activity.lastIndexedAt`, `lastIndexedCount`, and
  `lastIndexedThreadIds` for the most recent index work

Recall query text is not stored in health output; activity records query length
and result count only.
