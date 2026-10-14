#!/bin/zsh
# Builds Scriptwright.app from this folder on this Mac and puts it into Applications.
# Your projects and settings are not touched; the app finds them where they are.
source ~/.zprofile 2>/dev/null || true
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
arch=$(uname -m); [[ "$arch" == "arm64" ]] || arch=x64
echo "== Installing dependencies (quick if nothing changed)"
npm install --no-audit --no-fund
echo "== Building Scriptwright.app for $arch"
node scripts/build.mjs --prod
rm -rf release/mac release/mac-arm64
npx electron-builder --mac dir --$arch --publish never
app=$(ls -d release/mac*/Scriptwright.app | head -1)
echo "== Putting it into Applications"
osascript -e 'tell application "Scriptwright" to quit' 2>/dev/null || true
rm -rf /Applications/Scriptwright.app
ditto "$app" /Applications/Scriptwright.app
echo "== Starting"
open /Applications/Scriptwright.app
echo "Done. You can close this window."
