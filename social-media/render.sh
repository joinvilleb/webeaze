#!/usr/bin/env bash
# Render a month's posts to 1080x1080 PNGs. No npm dependencies, just Chrome.
#   ./render.sh aug-sep-2026
set -e
MONTH="${1:?usage: ./render.sh <month-slug>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

mkdir -p "$DIR/$MONTH/png"
n=0
for f in "$DIR/$MONTH/single/"*.html; do
  id="$(basename "$f" .html)"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1080,1080 --virtual-time-budget=15000 \
    --screenshot="$DIR/$MONTH/png/$id.png" "file://$f" >/dev/null 2>&1
  n=$((n+1)); printf "  %s\n" "$id.png"
done
echo "$n posts rendered to $MONTH/png/"
