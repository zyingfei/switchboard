# Adding a collector to Sidetrack

Stage 4 introduced the **pluggable collector framework**: a shape into which
any new behavioral signal source can be slotted without modifying the
companion or the plugin. This guide walks through writing a collector +
registering a materializer.

## What a collector is

A **collector** is a small, independently versioned process *the user
installs and runs themselves*. It tails one source of behavioral signal
(a CLI's session history, a git repo's reflog, a vendor API, …) and writes
append-only JSONL into a known directory. It never speaks to the network on
behalf of Sidetrack. It never imports a Sidetrack runtime. The companion
treats the collector's output the way it treats Class F plugin storage:
opaque-until-promoted records that pass through a single dedupe/promotion
choke point on their way into Class A.

The trust boundary is filesystem permissions on the inbox directory. There
is no bridge key, no auth token, no RPC. The wire IS the file.

## The contract

Every JSONL line a collector writes is a `CollectorEvent`:

```ts
interface CollectorEvent<T = unknown> {
  collector_id: string;        // forever-stable, e.g. "sidetrack.codex-cli"
  event_type: string;          // e.g. "session_turn"
  payload_version: number;     // monotone per (collector_id, event_type)
  emitted_at: string;          // RFC 3339 with timezone
  collector_version: string;   // SemVer of the writing collector
  collector_run_id: string;    // ULID, identifies one execution
  source_record_id?: string;   // collector-stable dedup key
  payload: T;                  // opaque to the framework; the materializer
                               // validates with Zod
  dimensions?: Record<string, unknown>;  // Lock 2 extension slot
}
```

UTF-8. One line per event. Newlines (`\n`) terminate each line. Atomic
write via temp-file-then-rename — the collector writes a `.tmp` file in
the same directory, then `rename(2)`s it into place. (Append-only is
acceptable on POSIX systems for single-line writes; the temp-file pattern
is the canonical recipe for batch writes.) **Do not** include timestamps
that race with the companion's read time — `emitted_at` is *your* clock,
recorded at write time.

## Where things live

Per-vault layout:

```
<vault>/_BAC/
├─ collectors/
│  └─ <collector_id>/
│     ├─ collector.toml          # the manifest
│     └─ <whatever>              # collector-specific files (optional)
├─ inbox/
│  └─ <collector_id>/
│     ├─ <YYYY-MM-DD>.jsonl     # current rotation (write here)
│     ├─ .bookmark.json          # framework-managed; do NOT touch
│     └─ archive/                # Stage 4.2 — older days
│        └─ <YYYY-MM-DD>.jsonl
└─ audit/
   └─ quarantine/
      └─ <YYYY-MM-DD>/
         └─ <collector_id>.jsonl  # framework writes here on bad lines
```

Collectors only ever write to `_BAC/inbox/<collector_id>/`. They never write
to `_BAC/events/` (that's Class A, owned by the companion), `_BAC/audit/`
(Class C, owned by the companion), or `_BAC/collectors/` (read-only at
runtime; the user installs manifests here).

## The manifest (collector.toml)

```toml
# Example: _BAC/collectors/sidetrack.codex-cli/collector.toml

# --- identity (Lock 5: distinct from manifest_schema and from framework) ---
id          = "sidetrack.codex-cli"   # forever-stable; never rename after release
name        = "Codex CLI History"
version     = "0.3.1"                 # SemVer; the collector's own release version
manifest_schema = 1                   # which version of THIS file format

# --- compatibility (Lock 5 + JetBrains since/until + Obsidian minAppVersion) ---
[compatibility]
requires-companion = ">=1.0.0 <2.0.0" # range over COLLECTOR_FRAMEWORK_VERSION,
                                       # NOT companion product version
requires-vault     = ">=1"             # vault layout major

# --- emission contract — what tuples will appear in the JSONL ---
[[emits]]
event_type = "session_started"
payload_version = 1
stability = "stable"

[[emits]]
event_type = "session_turn"
payload_version = 1
stability = "beta"

# --- I/O ---
[io]
output_dir = "_BAC/inbox/sidetrack.codex-cli/"
rotation = "daily"   # daily | size-1MB | size-10MB

# --- capabilities (Lock 4 privacy gates) ---
[capabilities]
reads-paths     = ["~/.codex/sessions/", "~/.codex/history.jsonl"]
reads-env       = ["CODEX_HOME"]
reads-network   = false
default-enabled = true   # set to false for sensitive collectors (e.g. shell)

# --- process model — informational only; the companion does NOT spawn ---
[process]
managed-by = "user"   # MUST be "user" in MVP; anything else rejects
```

## Lock 5 — the three SemVer streams

Stage 4 has three things that version *separately*:

1. **`payload_version`** — integer, per-`(collector_id, event_type)` tuple.
   Wire format snake_case. Increments by 1 on every breaking change;
   non-breaking changes (additive optional fields with defaults) do NOT
   increment. The companion's materializer registry keeps an *upcaster
   chain* — a list of pure functions that translate older payloads forward
   to the current shape, applied left-to-right at promotion time.
2. **`manifest_schema`** — integer, per spine release. Bumps when the
   `collector.toml` format itself changes (rare).
3. **`companion_framework_version`** — SemVer, per companion release.
   `[compatibility].requires-companion` is a range over THIS, not the
   companion's product version.

The three evolve on independent timelines. Collector authors can ship a
new version of their collector (bumping `version` and possibly
`payload_version` for one tuple) without coordinating with the companion's
release cadence. Companion authors can refactor the framework
internally without forcing every collector to re-release.

## FORWARD_TRANSITIVE compatibility

Producers (collectors) may upgrade first. Consumers (the companion's
materializer) MUST tolerate older payloads indefinitely. A companion at
framework version Y MUST accept any
`payload_version ∈ [1, max_known_to_Y(collector_id, event_type)]` and
MUST quarantine any `payload_version > max_known_to_Y` (never crash,
never silently drop). Lines parked in quarantine are **replayed on
upgrade** — the next time the companion boots with a higher
`max_known_to_Y`, the replay scan re-runs the materializer and promotes
to Class A, preserving the *original* `emitted_at` timestamp.

## Capabilities and privacy gates

Each `[capabilities]` entry becomes a Class A `privacy.permission.*` event
with `permission: "collector.<id>.<capability>"`. The companion does NOT
enforce these — the OS does (the collector is the user's process). What
the companion does is read gate state on every promotion attempt; denied
→ quarantine with `reason: "privacy-gate-denied"`. Re-granting the gate
later replays the quarantine.

`default-enabled = false` ships the collector with a pending gate state.
The user must affirmatively grant via the side panel before any line
promotes to Class A. Use this for sensitive sources (shell history,
clipboard contents, browsing private modes).

## Process model

`managed-by = "user"` is the only valid value in MVP. The companion
**never spawns** the collector and **never supervises** its liveness. The
collector is an OS process the user runs themselves (via a launchd plist,
systemd unit, login script, or just a shell-backgrounded `&`). The
companion observes the collector's *output*, not its *liveness*. If the
collector dies, the companion just doesn't see new lines — no error
state, no health alert, nothing destructive. The user notices when the
side-panel "last promoted at" timestamp falls behind, and they restart.

## Worked example: implementing a "ticker" collector

Smallest possible collector. Emits a tick once per second.

### 1. Write the manifest

```toml
# _BAC/collectors/myorg.ticker/collector.toml
id              = "myorg.ticker"
name            = "Ticker"
version         = "0.1.0"
manifest_schema = 1

[compatibility]
requires-companion = ">=1.0.0 <2.0.0"
requires-vault     = ">=1"

[[emits]]
event_type = "tick"
payload_version = 1
stability = "alpha"

[io]
output_dir = "_BAC/inbox/myorg.ticker/"
rotation = "daily"

[capabilities]
reads-paths     = []
reads-env       = []
reads-network   = false
default-enabled = true

[process]
managed-by = "user"
```

### 2. Write the collector binary

In whatever language. Pseudocode:

```python
import json, os, time, uuid, datetime

VAULT = os.environ['SIDETRACK_VAULT']
INBOX = os.path.join(VAULT, '_BAC', 'inbox', 'myorg.ticker')
RUN_ID = uuid.uuid7().hex[:26]  # ULID-ish

os.makedirs(INBOX, exist_ok=True)

i = 0
while True:
    line = {
        'collector_id': 'myorg.ticker',
        'event_type': 'tick',
        'payload_version': 1,
        'emitted_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'collector_version': '0.1.0',
        'collector_run_id': RUN_ID,
        'source_record_id': f'{RUN_ID}:{i:08d}',
        'payload': {'tick_index': i},
    }
    today = datetime.date.today().isoformat()
    target = os.path.join(INBOX, f'{today}.jsonl')
    tmp = target + f'.tmp.{os.getpid()}.{i}'
    with open(tmp, 'a') as f:
        f.write(json.dumps(line) + '\n')
    os.rename(tmp, target)  # atomic
    i += 1
    time.sleep(1)
```

(In production, batch lines per second to amortize the `rename(2)` cost,
and `fsync(2)` the parent dir periodically to ensure crash-durability.)

### 3. Add a materializer to the companion

The materializer lives in companion source. It tells the framework what
to do with each tuple:

```ts
// packages/sidetrack-companion/src/collectors/myorg-ticker/materializers.ts
import { z } from 'zod';
import {
  type MaterializerRegistration,
  type MaterializerRegistry,
} from '../framework/materializer.js';

const tickV1Schema = z.object({ tick_index: z.number().int().nonnegative() });
type TickV1 = z.infer<typeof tickV1Schema>;

export const tickerRegistration: MaterializerRegistration<TickV1, /* emitted */ {
  type: 'tick.observed';
  payloadVersion: 1;
  emittedAt: string;
  tickIndex: number;
  producedBy: { kind: 'collector'; ruleId: string; ruleVersion: string; runId: string };
}> = {
  collector_id: 'myorg.ticker',
  event_type: 'tick',
  current_payload_version: 1,
  versions: new Map([[1, { status: 'current' }]]),
  validate: (latest) => tickV1Schema.parse(latest),
  toClassA: (latest, env) => [
    {
      type: 'tick.observed',
      payloadVersion: 1,
      emittedAt: env.emitted_at,
      tickIndex: latest.tick_index,
      producedBy: {
        kind: 'collector',
        ruleId: `${env.collector_id}:${env.event_type}`,
        ruleVersion: env.collector_version,
        runId: env.collector_run_id,
      },
    },
  ],
};

export const registerTicker = (registry: MaterializerRegistry): void => {
  registry.register(tickerRegistration);
};
```

Then in `runtime.ts`, call `registerTicker(registry)` alongside the
existing built-ins.

### 4. Register the Class A event type

Add a `ContractEntry` row to `sync/contract/registry.ts` for the
`tick.observed` event type. The framework's coverage test enforces that
every event type in `*/events.ts` has exactly one entry.

### 5. Test it

- `bunx --no-install vitest run` against the materializer's test file.
- Manually: drop the manifest at `_BAC/collectors/myorg.ticker/`, run the
  collector binary, restart the companion, observe ticks promoted to
  Class A in the audit log + side-panel Collectors section.

## Adding a new payload version (FORWARD_TRANSITIVE upgrade)

When you need to make a breaking change to a payload:

1. Bump `payload_version` (e.g. 1 → 2).
2. Add a v2 schema + register both v1 and v2 in `versions`. v1 gets an
   `upcastTo` function that maps a v1 payload to a v2 shape.
3. The materializer's `current_payload_version` becomes 2; v1 status is
   `accepted`.
4. Old companion versions (that don't know v2) quarantine v2 lines until
   upgraded; replay-on-upgrade promotes them. Old collector versions (still
   emitting v1) work unchanged forever.

## Collector author checklist (before opening a PR)

- [ ] `collector_id` is dotted lowercase, follows
  `[a-z0-9][a-z0-9.-]*[a-z0-9]`, length 3..64. Never reused.
- [ ] `collector.toml` parses cleanly via `@iarna/toml`.
- [ ] Every `[[emits]]` tuple has a corresponding `MaterializerRegistration`.
- [ ] `source_record_id` is stable across collector restarts (not just
  unique within one run). Idempotent reprocessing requires it.
- [ ] Every Class A event the materializer emits is registered in
  `sync/contract/registry.ts` as a `ContractEntry`.
- [ ] `[capabilities].reads-paths` enumerates EVERY filesystem path the
  collector reads. (The OS is what enforces; the manifest is the user's
  audit trail.)
- [ ] `default-enabled` is `false` for collectors observing sensitive
  sources (shell history, clipboard, anything that may capture secrets).
- [ ] Per-collector fixture JSONL lines are checked in at
  `test/collectors/vectors/<collector_id>/<event_type>-v<n>.jsonl`. Real
  data, scrubbed of any user-identifying material.
- [ ] At least one materializer test covers `validate` + `toClassA` over
  each fixture line.
- [ ] Side-panel labels: the manifest's `name` is what users see. Make it
  short and descriptive.
- [ ] README in the collector's repo documents installation, configuration,
  and the data the collector emits.

## Out of scope (deferred to Stage 4.2 / 4.3)

- **Inbox archival/rotation beyond default 30-day retention.** The
  companion will eventually move yesterday's `<YYYY-MM-DD>.jsonl` to
  `archive/` and gzip; for now files accumulate. Set up a cron yourself
  if disk space is a concern.
- **Per-collector health metrics** in the side panel (last promoted
  timestamp, EWMA throughput, quarantine rate).
- **Cross-collector synthetic events.** If you need to unify "Codex CLI
  session_turn" and "Claude Code session_turn" into a canonical
  `coding-agent.session_turn` event, that's a Stage 4.3 conditional on
  real product need; for now both materializers emit the same Class A
  event type and the discriminator is `producedBy.ruleId`.
- **Marketplace, ratings, central registry, auto-update.** Not in MVP and
  may never ship — Sidetrack is local-first.

## Questions / extending the framework

The plan-doc is at
[`docs/proposals/stage-4-collector-framework.md`](./proposals/stage-4-collector-framework.md).
The compass artifact (the design contract from the external researcher) is
preserved at
[`design/stage-4-collector-framework/compass-source.md`](../design/stage-4-collector-framework/compass-source.md).
For the structural argument and the "what we steal / what we reject"
analysis across observability collectors, IDE plugins, and local-first sync
engines, read that doc first.
