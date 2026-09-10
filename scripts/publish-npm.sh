#!/usr/bin/env sh
set -e

# Publish platform optionalDependencies first, then the condense launcher.
# Usage: scripts/publish-npm.sh [--dry-run]

root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dry_run=""
if [ "${1:-}" = "--dry-run" ]; then
  dry_run="--dry-run"
fi

packages="
packages/condense-darwin-arm64
packages/condense-darwin-x64
packages/condense-linux-arm64
packages/condense-linux-x64
packages/condense-win32-x64
packages/cli
"

for pkg in $packages; do
  echo "[condense] npm publish $pkg $dry_run"
  (cd "$root/$pkg" && npm publish --access public $dry_run)
done
