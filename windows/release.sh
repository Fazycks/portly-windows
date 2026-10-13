#!/usr/bin/env bash
# Publishes a Portly for Windows release and its update feed.
#
#   windows/release.sh [notes.md]
#
# The version comes from src-tauri/tauri.conf.json; commit and push it to main
# first. The installer is signed with the updater key (default
# ~/.tauri/portly-windows.key, override with PORTLY_UPDATER_KEY); its public
# half is `plugins.updater.pubkey` in tauri.conf.json. Installed apps read
# latest.json from the latest release when they start, so every release must
# go through this script.
set -euo pipefail
cd "$(dirname "$0")"

key="${PORTLY_UPDATER_KEY:-$HOME/.tauri/portly-windows.key}"
repo="Fazycks/portly-windows"
version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
tag="v$version-windows"
notes_file="${1:-}"

[ -f "$key" ] || { echo "Updater signing key not found: $key" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first." >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Push main first: HEAD is not origin/main." >&2; exit 1; }
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  echo "Release $tag already exists; bump the version." >&2
  exit 1
fi

TAURI_SIGNING_PRIVATE_KEY="$(cat "$key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build

bundle="src-tauri/target/release/bundle/nsis"
setup="Portly_${version}_x64-setup.exe"
[ -f "$bundle/$setup" ] && [ -f "$bundle/$setup.sig" ] || { echo "Missing $setup or its signature." >&2; exit 1; }

notes="Portly for Windows $version"
[ -n "$notes_file" ] && notes="$(cat "$notes_file")"

VERSION="$version" NOTES="$notes" SIG="$(cat "$bundle/$setup.sig")" \
URL="https://github.com/$repo/releases/download/$tag/$setup" node -e '
  const e = process.env;
  process.stdout.write(JSON.stringify({
    version: e.VERSION,
    notes: e.NOTES,
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: e.SIG, url: e.URL } },
  }, null, 2) + "\n");
' > "$bundle/latest.json"

notes_args=(--notes "$notes")
[ -n "$notes_file" ] && notes_args=(--notes-file "$notes_file")
gh release create "$tag" "$bundle/$setup" "$bundle/latest.json" \
  --repo "$repo" --target main --latest --title "Portly for Windows $version" "${notes_args[@]}"
