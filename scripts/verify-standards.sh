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
  if command -v pnpm >/dev/null 2>&1; then
    pnpm run typecheck
    pnpm run lint
    pnpm run format:check
    pnpm run test
    pnpm run build
  elif command -v npm >/dev/null 2>&1; then
    npm run typecheck
    npm run lint
    npm run format:check
    npm test
    npm run build
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
