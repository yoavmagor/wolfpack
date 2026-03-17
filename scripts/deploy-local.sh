#!/bin/bash
set -e
cd "$(dirname "$0")/.."
bun run scripts/build.ts
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  BIN="wolfpack-darwin-arm64"
else
  BIN="wolfpack-darwin-x64"
fi
cp "dist/$BIN" ~/.wolfpack/bin/wolfpack
codesign -f -s - ~/.wolfpack/bin/wolfpack
DOMAIN="gui/$(id -u)"
SERVICE="com.wolfpack.server"
PLIST="$HOME/Library/LaunchAgents/$SERVICE.plist"
if launchctl kickstart -k "$DOMAIN/$SERVICE" 2>/dev/null; then
  echo "deployed and restarted"
elif [ -f "$PLIST" ]; then
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "deployed and bootstrapped"
else
  echo "deployed — no plist found, run 'wolfpack service install' first"
fi
