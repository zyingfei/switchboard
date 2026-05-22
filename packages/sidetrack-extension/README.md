# @sidetrack/extension

The Sidetrack Chrome MV3 extension — the side-panel workboard plus the
content scripts that capture AI conversations and page content. Built
with [WXT](https://wxt.dev/). It is sensor + UI only: all state is
owned by the companion's vault.

## Build & run

```bash
bun run build      # wxt build → .output/chrome-mv3
bun run dev        # wxt watch mode
```

Load `.output/chrome-mv3` as an unpacked extension at
`chrome://extensions` (Developer mode), then paste the companion's
bridge key into the side panel's settings. Full setup:
[`../../INSTALL.md`](../../INSTALL.md).

## Scripts

| Command | What it does |
|---|---|
| `bun run build` / `dev` | WXT production build / watch |
| `bun run test` | Vitest suite |
| `bun run typecheck` / `lint` / `format:check` | Static checks |
| `bun run e2e` | Playwright end-to-end (builds + prepares a companion) |

## Layout

- **`entrypoints/`** — the MV3 entry points: `background.ts` (service
  worker), `sidepanel/` (the workboard UI), `content.ts` + other
  content scripts (capture, title watch, engagement, visual
  fingerprint).
- **`src/capture/`** — per-provider capture config + extraction for
  ChatGPT, Claude, Gemini.
- **`src/companion/`** — the typed client for the companion's
  localhost API, including the connection identity check.
- **`src/contentOverlays/`** — the on-page Déjà-vu ("seen this
  before") popover.
- **`src/sidepanel/`** — side-panel components: workstreams, inbox,
  suggestions, connections, recall search.
- **`src/sync/`, `src/mcpHost/`, `src/tabsession/`, …** — sync
  transport, MCP host wiring, tab-session tracking.

## Conventions

Read [`../../AGENTS.md`](../../AGENTS.md) and
[`../../standards/03-ts-browser-plugin.md`](../../standards/03-ts-browser-plugin.md)
first — service-worker lifecycle, typed message bus, content-script
isolation, permission minimization, storage migrations. Cross-context
messages are typed contracts in `src/messages.ts`.
