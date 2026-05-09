# Collector brief template

Use this template when adding a new collector under the Stage 4 framework.
Each brief is a single self-contained document; once approved, the
materializer can be written in an afternoon.

## 1. `collector_id`

`sidetrack.<short-name>` — forever-stable, dotted, lowercase, never rename.

## 2. `version`

Initial SemVer (e.g. `0.1.0`). Bumps independently from companion / framework.

## 3. `manifest_schema`

Always `1` in Stage 4.0. Bumps when the manifest format changes (rare).

## 4. Observed source(s)

Concrete data the collector tails. Be explicit about file paths, env vars,
or APIs. Examples:
- "JSONL session rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`."
- "Per-shell history: `~/.bash_history`, `~/.zsh_history`,
  `~/.local/share/fish/fish_history`."

## 5. Emit list

For each `(event_type, payload_version)`:

### `<event_type>` v<n>

- **`source_record_id` derivation rule** (CRITICAL — drives idempotency):
  e.g. `${session_id}:${turn_index}` or `${commit_sha}` or
  `${repo}#${pr_number}#${event_uuid}`.
- **Reference parser library or format spec**: link to upstream format docs
  or library name.
- **Sample raw line:**
  ```json
  { "collector_id": "...", "event_type": "...", "payload_version": 1, ... }
  ```
- **Sample materialized Class A event** (post `toClassA`):
  ```json
  { "type": "coding.session.turn.observed", ... }
  ```
- **`dimensions` slot fields (Lock 2):** declare the optional metadata the
  collector populates.

## 6. Capabilities block

```toml
[capabilities]
reads-paths     = [...]
reads-env       = [...]
reads-network   = false   # set true only if the collector polls external services
default-enabled = true    # false for sensitive collectors (e.g. shell history)
```

## 7. Expected source-file paths

Where the collector reads from. Should match `[capabilities].reads-paths`.

## 8. Quarantine reasons specific to this collector

Per-collector `QuarantineReason` extensions if the framework's default set
is insufficient. (Most collectors don't need new reasons.)

## 9. Simplest test that proves it works

A 2-3 step manual procedure that produces one observable Class A event end
to end. Form: "Run X. Observe Y. Confirm Z." Drives the smoke test in the
`test/vectors/<collector_id>/` fixtures.
