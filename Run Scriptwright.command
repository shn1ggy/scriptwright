#!/bin/zsh
# Starts Scriptwright on a Mac. If a newer scriptwright-findreplace.zip lies next to this folder
# (in Downloads), it is unpacked over this folder first (node_modules is kept).
source ~/.zprofile 2>/dev/null || true
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
set -e
here="$(cd "$(dirname "$0")" && pwd)"
zip="$here/../scriptwright-findreplace.zip"
if [[ -f "$zip" && "$zip" -nt "$here/.updated" ]]; then
  echo "== Updating Scriptwright"
  rm -rf /tmp/sw-update && mkdir -p /tmp/sw-update
  unzip -q -o "$zip" -d /tmp/sw-update
  rsync -a --exclude node_modules --exclude .git /tmp/sw-update/scriptwright/ "$here/"
  touch "$here/.updated"
fi
cd "$here"
echo "== Installing dependencies (quick if nothing changed)"
npm install --no-audit --no-fund
echo "== Building and starting"
npm start
