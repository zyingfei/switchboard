#!/usr/bin/env bash
#
# Build the Sidetrack menu-bar app and assemble a runnable
# Sidetrack.app bundle under .build/.
#
# Uses SwiftPM to compile the executable (no Xcode project needed),
# then hand-assembles a proper .app layout with the Info.plist
# (LSUIElement = menu-bar-only, bundle id local.sidetrack.menubar).
#
# NOT signed or notarized — this is a local dev tool. See README.md for
# the first-launch Gatekeeper right-click-open note.
#
# Usage:
#   ./build.sh              release build (default)
#   ./build.sh debug        debug build
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

CONFIG="${1:-release}"
case "$CONFIG" in
  release|debug) ;;
  *) echo "usage: $0 [release|debug]" >&2; exit 2 ;;
esac

APP_NAME="Sidetrack"
BUNDLE_ID="local.sidetrack.menubar"
BUILD_ROOT="$APP_DIR/.build"
APP_BUNDLE="$BUILD_ROOT/$APP_NAME.app"

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG"

BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/$APP_NAME"
if [ ! -x "$BIN_PATH" ]; then
  echo "build produced no executable at $BIN_PATH" >&2
  exit 1
fi

echo "==> assembling $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

cp "$BIN_PATH" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
cp "$APP_DIR/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# PkgInfo — legacy but harmless; some Finder paths still read it.
printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

# Ad-hoc sign so the app can run locally without a "damaged" prompt on
# recent macOS. This is NOT notarization — Gatekeeper still requires the
# first-launch right-click-open (see README). Ignore failure so the
# bundle is still produced on machines without codesign.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 \
    && echo "==> ad-hoc signed" \
    || echo "==> codesign skipped (ad-hoc sign failed; app still runnable)"
fi

echo
echo "Built: $APP_BUNDLE"
echo "Bundle id: $BUNDLE_ID"
echo "Run:   open \"$APP_BUNDLE\""
echo "Or install: cp -R \"$APP_BUNDLE\" /Applications/"
