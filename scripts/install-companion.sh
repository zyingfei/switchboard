#!/usr/bin/env bash
#
# One-line Sidetrack companion setup. Builds the companion if needed,
# then either installs it as a background service (recommended) or runs
# it in the foreground. On first run it prints a bridge key (also saved
# to <vault>/_BAC/.config/bridge.key) — paste that into the extension,
# or use "Load key from file…" in Settings → Companion connection and
# pick the bridge.key file.
#
# Recommended (unattended background service — launchd on macOS,
# systemd --user on Linux; survives restarts and crashes):
#   bash scripts/install-companion.sh --vault ~/Documents/Sidetrack-vault --service
#
# Foreground / dev (leave the terminal open; Ctrl-C to stop):
#   bash scripts/install-companion.sh --vault ~/my-vault --port 17374
#
# (The npm package isn't published yet, so a global `bunx
# @sidetrack/companion` won't resolve — this runs the built CLI from the
# repo, which is the supported path today.)
set -euo pipefail

VAULT=""
PORT="17373"
SERVICE="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --vault)   VAULT="${2:-}"; shift 2 ;;
    --port)    PORT="${2:-}";  shift 2 ;;
    --service) SERVICE="1";    shift 1 ;;
    -h|--help)
      echo "usage: install-companion.sh --vault <path> [--port 17373] [--service]"
      echo ""
      echo "  --service   Install as a background service (recommended): auto-starts"
      echo "              at login and respawns on crash. Without it the companion"
      echo "              runs in the foreground (dev mode; Ctrl-C to stop)."
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$VAULT" ]; then
  echo "usage: install-companion.sh --vault <path> [--port 17373] [--service]" >&2
  exit 1
fi

# Expand a leading ~ so the path the companion sees matches what the
# user typed in the wizard.
case "$VAULT" in
  "~"|"~/"*) VAULT="${HOME}/${VAULT#"~/"}"; VAULT="${VAULT%/}" ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPANION_DIR="$REPO_ROOT/packages/sidetrack-companion"

if [ ! -d "$COMPANION_DIR" ]; then
  echo "[install-companion] companion package not found at $COMPANION_DIR" >&2
  exit 1
fi

cd "$COMPANION_DIR"

if [ ! -f dist/cli.js ]; then
  echo "[install-companion] dist/cli.js missing — building companion…"
  bunx --bun --no-install tsc -p tsconfig.build.json
fi

echo "[install-companion] vault     : $VAULT"
echo "[install-companion] port      : $PORT"
echo "[install-companion] bridge key: $VAULT/_BAC/.config/bridge.key"

if [ "$SERVICE" = "1" ]; then
  # Recommended run mode: register a login service (launchd/systemd) that
  # auto-starts and respawns the companion unattended. --install-service
  # prints the exact pairing + management next-steps and returns.
  echo "[install-companion] installing background service (auto-start + respawn)…"
  exec bun --smol dist/cli.js --install-service --vault "$VAULT" --port "$PORT"
fi

echo "[install-companion] starting in the foreground — leave this running; Ctrl-C to stop."
echo "[install-companion] tip: re-run with --service to install an unattended background service."
exec bun --smol dist/cli.js --vault "$VAULT" --port "$PORT"
