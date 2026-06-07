#!/usr/bin/env bash
#
# One-line Sidetrack companion setup. Builds the companion if needed,
# then starts it in the foreground. On first run it prints a bridge key
# (also saved to <vault>/_BAC/.config/bridge.key) — paste that into the
# extension, or use "Load key from file…" in Settings → Companion
# connection and pick the bridge.key file.
#
#   bash scripts/install-companion.sh --vault ~/Documents/Sidetrack-vault
#   bash scripts/install-companion.sh --vault ~/my-vault --port 17374
#
# (The npm package isn't published yet, so a global `bunx
# @sidetrack/companion` won't resolve — this runs the built CLI from the
# repo, which is the supported path today.)
set -euo pipefail

VAULT=""
PORT="17373"
while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="${2:-}"; shift 2 ;;
    --port)  PORT="${2:-}";  shift 2 ;;
    -h|--help)
      echo "usage: install-companion.sh --vault <path> [--port 17373]"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$VAULT" ]; then
  echo "usage: install-companion.sh --vault <path> [--port 17373]" >&2
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
echo "[install-companion] bridge key: $VAULT/_BAC/.config/bridge.key (printed below on first run)"
echo "[install-companion] starting — leave this running; Ctrl-C to stop."
exec bun --smol dist/cli.js --vault "$VAULT" --port "$PORT"
