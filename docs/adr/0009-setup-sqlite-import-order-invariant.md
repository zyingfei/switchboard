# ADR-0009 — setup-sqlite import-order invariant

- Status: Accepted (retroactive, 2026-07-11)
- Date: 2026-07-11
- Owner: User + Claude
- Components: API | Shared
- Related: ADR-0004, ADR-0006

## Context

The sqlite-vec extension requires a system-provided SQLite shared
library with extension-loading enabled (`ENABLE_LOAD_EXTENSION`).
Bun's bundled SQLite (`bun:sqlite`) does not have this enabled by
default. Bun provides `Database.setCustomSQLite(path)` to point the
runtime at an alternative library, but this call has a critical
constraint: it must be invoked **before any `new Database(...)`
constructor is called anywhere in the process** — Bun caches the
library handle on first use and subsequent `setCustomSQLite` calls
throw "SQLite already loaded".

In practice, `packages/sidetrack-companion/src/connections/snapshot.ts`
opens a Database as a side effect of its module evaluation (for the
`SqliteConnectionsStore`). ESM import declaration hoisting means any
attempt to call `setCustomSQLite` in a function body after all imports
have evaluated is inherently racy.

The module `packages/sidetrack-companion/src/recall-v2/store/setup-sqlite.ts`
was designed to solve this: it calls `setCustomSQLite` as a module
side effect at evaluation time, so the companion's `cli.ts` only needs
to import it as its **first static import**. ESM depth-first evaluation
guarantees this module evaluates completely before any subsequent
import in the same file.

`cli.ts` documents this constraint with a prominent comment:

```
// MUST be the first import — calls `Database.setCustomSQLite()` to
// point Bun at a system SQLite with extension loading enabled
```

## Decision

The `setup-sqlite.ts` module must be the **first static import** in
`packages/sidetrack-companion/src/cli.ts` (and any other Bun-process
entrypoints that use sqlite-vec). This is a hard ordering invariant
enforced by documentation and linting, not by a runtime guard.

The module performs `setCustomSQLite` as a module-evaluation side
effect (not in an exported function) so that the import order alone is
sufficient — no manual call is needed.

The exported `installCustomSqlite()` function is a no-op kept for
backwards compatibility and explicit re-probing in tests; it calls
the same idempotent internal `doInstall()` function.

## Options considered

### Option A — Call setCustomSQLite in an async init function before other setup

Pros:
- Explicit call site; easier to audit.

Cons:
- ESM import hoisting evaluates all static imports before any function
  body in the importing module runs. Any static import that
  transitively opens a Database runs before the init function.
  This pattern is inherently broken for this constraint.

### Option B — Side effect at module evaluation time + first-import rule (chosen)

Pros:
- Correct by construction: depth-first ESM evaluation guarantees the
  setup module runs before any other import body in `cli.ts`.
- No manual call required in `cli.ts`.
- Idempotent: the `doInstall()` guard means double-evaluation (hot
  reload, test shimming) is safe.

Cons:
- Import order is a non-obvious constraint that must be documented
  and enforced by convention.
- Violating the order (e.g. reordering imports with an auto-formatter)
  silently breaks sqlite-vec. Mitigation: prominent comment in
  `cli.ts` and this ADR.

### Option C — Bundle Bun with a pre-patched SQLite

Pros:
- Eliminates the runtime constraint entirely.

Cons:
- Requires distributing a custom Bun build; not compatible with the
  standard Bun install path (ADR-0004).

## Consequences

Positive:
- sqlite-vec loads reliably on macOS (Homebrew libsqlite3) and Linux
  (system libsqlite3) without requiring a custom Bun build.
- The recall-v2 store, connections store, and event-store can coexist
  in the same process with the correct library loaded.

Negative:
- Import order in `cli.ts` is a load-bearing invariant. Auto-formatters
  that sort imports alphabetically may break it silently.
- Contributors adding new Bun entrypoints that use sqlite-vec must
  replicate the first-import pattern.

## Extension model

Any new Bun-process entrypoint (companion worker, CLI tool) that uses
sqlite-vec must import `setup-sqlite.ts` as its first static import.
Test files that need sqlite-vec must either import it first or call
`installCustomSqlite()` before opening a Database.

## Security and operations impact

`setCustomSQLite` accepts a filesystem path. The module probes a fixed
allow-list of known system library paths plus `SIDETRACK_SQLITE_LIB`
(env var). No network access. If no path is found, the call is
silently skipped and the default Bun SQLite is used (sqlite-vec will
fail to load, surfaces as a recall-store initialization error, not a
process crash).
