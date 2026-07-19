# Sidetrack menu-bar app

A native SwiftUI **MenuBarExtra** macOS app that makes the otherwise-invisible
Sidetrack companion daemon visible: is it up, **which build** is running, and
one-click start / stop / restart.

The companion runs today as a detached `screen` session — invisible, with a
hand-rolled restart recipe. There is no glance-able signal for "is it up" or
"which build" (a real foot-gun: a stale 42h-old process once ran unnoticed).
This app fixes that.

**Local-first:** the app makes **zero external network calls**. It talks only
to `127.0.0.1:<port>` (the companion's loopback API) and reads the bridge key
from the vault on disk. Nothing leaves the machine.

## What it shows

The menu-bar item is a status glyph + a one-word label (`up` / `down` / `busy`).
The dropdown shows:

- **RUNNING** (green ●) / **STOPPED** (gray ○) / **UNREACHABLE** (orange, port
  bound but the daemon isn't answering — it can take 30s+ under load).
- `companionVersion`, **`buildSha` + `buildBranch` + `buildTime`** (from the
  companion's `/v1/version`, stamped into `dist/BUILD_INFO.json` at build time),
  `pid`, `port`, `instanceLabel`, **uptime** (derived from `startedAt`),
  `vaultRoot`.
- When STOPPED: a clear "not running" message + a **Start** button.

`buildSha` is the field that answers *"which build is running"* — diff it against
`git rev-parse --short HEAD` in your checkout to catch a stale dist.

## Actions

- **Start / Stop / Restart** — shells out to the proven dogfood recipe,
  parameterised by instance label + port:
  - Restart = `screen -S sidetrack-companion-<label> -X quit` +
    `pkill -9 -f 'cli.js.*<port>'` +
    `screen -dmS sidetrack-companion-<label> /bin/zsh -lc 'exec scripts/run-test-companion.sh'`
  - The launch uses a **login shell** (`/bin/zsh -lc`) so `PATH` resolves
    `bun`/`npx`, exactly like the manual recipe. `kill -9` is safe — the
    companion's `recovery.ts` handles an abrupt exit.
- **Open Vault** — reveals `vaultRoot` in Finder.
- **Copy Diagnostics** — copies a paste-ready blob (version, build, pid, paths).
- **Instance switcher** — Test (17374) / Daily (17373). The choice persists in
  UserDefaults. Default is **Test**.
- **Quit** (⌘Q).

The start/restart shell-out needs the repo root (to find
`scripts/run-test-companion.sh`). It is discovered automatically — first from the
running companion's `codePath`, then from a few conventional `$HOME` locations.

## Build

Requires the Swift toolchain (`swift` / `swiftc`) — macOS 14+.

```sh
cd apps/sidetrack-menubar
./build.sh            # release (default); ./build.sh debug for a debug build
```

This runs `swift build`, then assembles a runnable bundle at:

```
apps/sidetrack-menubar/.build/Sidetrack.app
```

The bundle is **ad-hoc signed** (not notarized — this is a local dev tool).

## Install & run

```sh
# Run in place:
open apps/sidetrack-menubar/.build/Sidetrack.app

# Or install to /Applications:
cp -R apps/sidetrack-menubar/.build/Sidetrack.app /Applications/
open /Applications/Sidetrack.app
```

Because `LSUIElement` is set, there is **no Dock icon** — look for the status
glyph in the menu bar.

### First-launch Gatekeeper note

The app is **not signed with a Developer ID and not notarized**. On first launch
macOS Gatekeeper will refuse to open it with a double-click. Open it once via:

- **Right-click (or Control-click) the app → Open → Open** in the dialog, **or**
- System Settings → Privacy & Security → scroll to the blocked-app notice →
  **Open Anyway**.

After the first approved launch it opens normally.

### Launch at login (optional)

To have it start automatically:

System Settings → **General → Login Items** → **Open at Login** → **+** → select
`Sidetrack.app`.

(Alternatively, drag `Sidetrack.app` into the Login Items list.)

## Configuration

- **Instance** (Test/Daily) is chosen from the dropdown and persists in
  UserDefaults (`SidetrackCompanionInstance`).
- **Port + vault** derive from the instance (17374/`~/.sidetrack-vault-test`,
  17373/`~/.sidetrack-vault`).
- **Bridge key** is read from `<vaultRoot>/_BAC/.config/bridge.key` at poll time —
  never hardcoded.
- **Repo root** (for start/restart) is auto-discovered; if discovery ever fails
  you can set `SidetrackRepoRoot` in UserDefaults
  (`defaults write local.sidetrack.menubar SidetrackRepoRoot <path>`).

## How it stays responsive

The daemon can take 30s+ to answer under load (drain / index rebuild). The app
never blocks the UI on it:

- `/v1/version` polls run on an async `URLSession` with an 8s timeout, on a
  ~3s cadence, one at a time.
- A cheap `NWConnection` TCP probe distinguishes **UNREACHABLE** (port bound but
  slow) from **STOPPED** (nothing listening) without waiting out the HTTP
  timeout.
