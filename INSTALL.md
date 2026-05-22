# Running Sidetrack

Sidetrack is local-first and built from source — there is no published
installer yet. You run two pieces on your own machine:

- the **companion** — a Bun process that owns your vault and serves a
  localhost API;
- the **extension** — an unpacked Chrome MV3 extension (the side panel
  + the capture content scripts).

An optional **MCP server** exposes your vault read-only to coding
agents.

## Prerequisites

- **Bun** ≥ 1.3.14 (the repo pins `bun@1.3.14`)
- **Chrome** (or a Chromium with MV3 + side-panel support)
- macOS, Linux, or Windows

## 1. Install dependencies and build

```bash
bun install
bun run build      # builds every package under packages/*
```

`bun run verify` additionally runs format-check, lint, typecheck, and
the test suites — use it before sending a PR.

## 2. Run the companion

The companion owns the vault. Point it at any directory; Sidetrack
writes only under that directory's `_BAC/` namespace.

```bash
cd packages/sidetrack-companion
bun dist/cli.js --vault ~/sidetrack-vault --port 17373
```

On first run it prints a **bridge key** (also saved to
`<vault>/_BAC/.config/bridge.key`). Keep that — the extension needs it.

To run the companion as a background service instead of a foreground
process (launchd on macOS, systemd user unit on Linux, Scheduled Task
on Windows):

```bash
bun dist/cli.js --install-service --vault ~/sidetrack-vault --port 17373
bun dist/cli.js --service-status
bun dist/cli.js --uninstall-service
```

`bun dist/cli.js --help` lists every flag (recall model cache, sync
relay, MCP port, …).

## 3. Load the extension

The build emits an unpacked MV3 extension at
`packages/sidetrack-extension/.output/chrome-mv3`.

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select
   `packages/sidetrack-extension/.output/chrome-mv3`.
3. Open the Sidetrack side panel and paste the bridge key from step 2
   into its companion settings.

`bun run --cwd packages/sidetrack-extension dev` runs WXT in watch mode
during development.

## 4. (Optional) MCP server for coding agents

Pass `--mcp-port` to the companion and it spawns the sibling
`sidetrack-mcp` Streamable-HTTP server pointed at itself (read-only;
shares the companion's lifetime):

```bash
bun dist/cli.js --vault ~/sidetrack-vault --port 17373 --mcp-port 17374
```

If `--mcp-auth-key` is omitted, a persistent key is created under
`<vault>/_BAC/.config`.

## Notes

- The companion downloads a small embedding model on first recall use
  into a platform cache (`--models-dir` / `SIDETRACK_MODELS_DIR` to
  override; `--offline-models` to forbid downloads).
- One companion owns one vault at a time (a lock under
  `_BAC/recall/`). To run a second instance for testing, give it a
  separate `--vault` and `--port` — see
  [`scripts/run-test-companion.sh`](scripts/run-test-companion.sh).
- This is dogfood-stage software: you build it, you run it, the data
  is yours on disk. There is no telemetry and no account.
