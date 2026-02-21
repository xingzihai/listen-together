#!/bin/bash
# ListenTogether deploy script — auto-increment cache version + restart
set -e
cd "$(dirname "$0")"

# Auto-increment ?v=N in index.html
CURRENT_V=$(grep -oP '\?v=\K[0-9]+' web/static/index.html | head -1)
NEXT_V=$((CURRENT_V + 1))
sed -i "s/?v=${CURRENT_V}/?v=${NEXT_V}/g" web/static/index.html
echo "Cache version: v=${CURRENT_V} → v=${NEXT_V}"

# Update version tag
SHORT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# Read current version tag, increment patch
CURRENT_TAG=$(grep -oP 'v\d+\.\d+\.\d+' web/static/index.html | head -1 || echo "v0.6.0")
MAJOR=$(echo "$CURRENT_TAG" | cut -d. -f1)
MINOR=$(echo "$CURRENT_TAG" | cut -d. -f2)
PATCH=$(echo "$CURRENT_TAG" | cut -d. -f3)
NEW_PATCH=$((PATCH + 1))
NEW_TAG="${MAJOR}.${MINOR}.${NEW_PATCH}"
sed -i "s/${CURRENT_TAG}/${NEW_TAG}/" web/static/index.html
echo "Version: ${CURRENT_TAG} → ${NEW_TAG} (${SHORT_HASH})"

# Build
echo "Building..."
/usr/local/go/bin/go build -o listen-together . 2>&1

# Restart — kill all listen-together processes (including zombies' parents)
echo "Restarting..."
pkill -9 -f "listen-together" 2>/dev/null || true
sleep 1
# Clean up any remaining zombie processes
kill -9 $(ps aux | grep listen-together | grep -v grep | awk '{print $2}') 2>/dev/null || true
sleep 1
nohup ./listen-together > /tmp/listen-together.log 2>&1 &
sleep 2

# Verify
if pgrep -f "./listen-together" > /dev/null; then
    echo "✅ Deployed ${NEW_TAG} (cache v=${NEXT_V})"
else
    echo "❌ Failed to start!"
    tail -5 /tmp/listen-together.log
    exit 1
fi
