#!/bin/bash
set -e
cd "$(dirname "$0")/.."
bun run scripts/build.ts
cp dist/wolfpack-darwin-arm64 ~/.wolfpack/bin/wolfpack
codesign -f -s - ~/.wolfpack/bin/wolfpack
launchctl kickstart -k "gui/$(id -u)/com.wolfpack.server"
echo "deployed and restarted"
