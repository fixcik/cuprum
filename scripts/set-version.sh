#!/usr/bin/env bash
# Set the Cuprum version across every manifest that carries it.
#
# Cuprum's crates inherit `version.workspace`, but the Tauri UI lives in its own
# excluded workspace, so its version must be bumped separately. This keeps the
# Rust workspace, the Tauri app (Cargo.toml + tauri.conf.json), and the JS
# package in lockstep. Cargo.lock files are refreshed by the caller
# (`cargo update --workspace`), which only needs a network-capable environment.
#
# Usage: scripts/set-version.sh <X.Y.Z>
set -euo pipefail

VERSION="${1:?usage: set-version.sh <X.Y.Z>}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
  echo "error: '$VERSION' is not a semver version" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. Rust workspace version (all crates inherit version.workspace).
sed -i.bak -E "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$ROOT/Cargo.toml"

# 2. Tauri UI crate (separate, excluded workspace).
sed -i.bak -E "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$ROOT/cuprum-ui/src-tauri/Cargo.toml"

# 3. tauri.conf.json — the version compiled into the app and surfaced via
#    `getVersion()` in the UI.
tmp="$(mktemp)"
jq --arg v "$VERSION" '.version = $v' "$ROOT/cuprum-ui/src-tauri/tauri.conf.json" > "$tmp"
mv "$tmp" "$ROOT/cuprum-ui/src-tauri/tauri.conf.json"

# 4. JS package.json (kept in sync for tooling that reads it).
tmp="$(mktemp)"
jq --arg v "$VERSION" '.version = $v' "$ROOT/cuprum-ui/package.json" > "$tmp"
mv "$tmp" "$ROOT/cuprum-ui/package.json"

# Drop sed backups.
find "$ROOT" -maxdepth 3 -name '*.bak' -delete

echo "Set version to $VERSION"
