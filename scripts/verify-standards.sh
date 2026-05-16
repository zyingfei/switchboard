#!/usr/bin/env bash
set -euo pipefail

# Starter verification aggregator. Copy into repo root and customize per package manager/language.

run_if_exists() {
  local cmd="$1"
  if command -v ${cmd%% *} >/dev/null 2>&1; then
    echo "==> $cmd"
    eval "$cmd"
  else
    echo "Skipping missing command: ${cmd%% *}"
  fi
}

if [ -f package.json ]; then
  if command -v bun >/dev/null 2>&1; then
    bun run typecheck
    bun run lint
    bun run format:check
    bun run test
    bun run build
  else
    echo "Missing bun; install Bun 1.3.14 or newer."
    exit 1
  fi
fi

if [ -f pyproject.toml ]; then
  run_if_exists "ruff check ."
  run_if_exists "ruff format --check ."
  run_if_exists "mypy ."
  run_if_exists "pytest"
fi

if [ -f go.mod ]; then
  go vet ./...
  go test ./...
fi

echo "Standards verification completed. Customize this script for repo-specific packages."
