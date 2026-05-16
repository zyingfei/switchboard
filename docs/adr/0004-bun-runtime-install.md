# ADR-0004 - Bun runtime and package manager

- Status: Accepted
- Date: 2026-05-16
- Owner: User + Codex
- Components: API | MCP | Browser Plugin | Shared
- Supersedes: Runtime, package-manager, install-command, and update-command details in ADR-0001. ADR-0001 remains accepted for the HTTP loopback architecture.

## Context

Sidetrack now has production packages under `packages/*` plus several PoC packages that share TypeScript, Vitest, WXT, Playwright, MCP SDK, and native dependencies. The repo previously used per-package `package-lock.json` files and npm/npx scripts, while the product direction is a single local-first toolchain that can run TypeScript entrypoints directly and keep workspace dependency state consistent.

The install-path decision in ADR-0001 remains correct: the companion is a long-lived HTTP loopback process, not a Native Messaging host. Only the runtime/package-manager details of that ADR have changed.

## Decision

Adopt Bun as the required JavaScript runtime and package manager for Sidetrack.

- Pin the repo to `bun@1.3.14` via root `packageManager` and require `engines.bun >=1.3.14`.
- Use one root Bun workspace and one root `bun.lock`.
- Remove tracked `package-lock.json` files.
- Run repo scripts through `bun run`.
- Run local package CLIs through `bunx --bun --no-install` so tools execute under Bun and do not silently install missing tools during verification. Vitest is the exception: it runs as `bunx --no-install vitest` because the current Vitest/Rolldown stack is not stable under Bun 1.3.14.
- Public install snippets use `bunx @sidetrack/companion` and `bunx @sidetrack/mcp`.
- The companion auto-update path uses `bun update --global @sidetrack/companion`.
- The macOS staged bundle requires a system `bun` on `PATH`; it does not embed Bun.

## Options considered

### Option A - Keep Node/npm

Pros:

- Familiar to the wider JavaScript ecosystem.
- Matches the historical ADR-0001 examples.

Cons:

- Keeps many per-package lockfiles and duplicate installs.
- Requires tsx or compiled JS for TypeScript entrypoint execution.
- Makes workspace-wide verification more cumbersome.

### Option B - Require Bun

Pros:

- One workspace install and one lockfile.
- Native TypeScript entrypoint execution for local CLIs and PoCs.
- Faster install/test/build loops for the current repo shape.
- Public commands align with the runtime used in development and service installs.

Cons:

- Contributors must install Bun.
- Some dependencies with lifecycle scripts must be explicitly trusted.
- Compatibility regressions must be caught in tests because the runtime changes from Node to Bun.

### Option C - Support both npm and Bun

Pros:

- Lower transition friction.

Cons:

- Doubles install/test paths.
- Reintroduces lockfile drift.
- Weakens the production install contract.

## Consequences

Positive:

- Development, CI, PoCs, public commands, and service install commands share one runtime.
- TypeScript CLIs can run without tsx.
- Workspace scripts can verify production packages from the repo root.
- Dependency state is anchored by one root `bun.lock`.

Negative:

- `bun install` becomes mandatory before local verification.
- The staged macOS bundle is not self-contained; users need Bun installed separately.
- Native dependencies continue to require explicit lifecycle-script trust.

## Extension model

New packages should be added to the root `workspaces` list, set `packageManager: "bun@1.3.14"`, declare `engines.bun`, and use shared scripts that call `bunx --bun --no-install` for local CLIs. Use `bunx --no-install vitest` for Vitest until the Bun runtime path is stable. If a future non-JavaScript component is added, it can keep its native toolchain, but JavaScript/TypeScript packages remain in the Bun workspace.

## Security and operations impact

The root `trustedDependencies` list is the only place dependency lifecycle scripts are allowed by default. Public companion auth, loopback binding, bridge-key behavior, and vault ownership are unchanged from ADR-0001. Auto-update changes command shape only; it still updates the published companion package.

## Follow-ups

- [ ] Wire `bun install --frozen-lockfile` and `bun run verify` into CI.
- [ ] Revisit the macOS bundle once the product needs a self-contained installer.
