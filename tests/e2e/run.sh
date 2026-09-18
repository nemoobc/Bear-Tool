#!/usr/bin/env bash
# Bear Tool — browser E2E runner (Playwright).
# Starts a local static server if none is running, then runs the full suite.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${BEAR_PORT:-8080}"
BASE_URL="${BEAR_BASE_URL:-http://localhost:$PORT}"

# 1. Server: reuse if already up, otherwise start one.
if ! curl -sf -o /dev/null "$BASE_URL/"; then
  echo "→ starting static server on :$PORT"
  (cd "$ROOT" && python3 -m http.server "$PORT" >/tmp/bear-e2e-server.log 2>&1 &)
  for i in $(seq 1 20); do
    curl -sf -o /dev/null "$BASE_URL/" && break
    sleep 0.5
  done
fi
curl -sf -o /dev/null "$BASE_URL/" || { echo "✗ server not reachable at $BASE_URL"; exit 1; }
echo "✓ server up: $BASE_URL"

# 2. Browser shared libs (container workaround — no system package install).
#    Override with BEAR_BROWSER_LIBS if your extraction dir differs.
LIBS="${BEAR_BROWSER_LIBS:-/tmp/opencode/browser-libs/extracted/usr/lib/x86_64-linux-gnu}"
if [ -d "$LIBS" ]; then
  export LD_LIBRARY_PATH="$LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  echo "✓ browser libs: $LIBS"
fi

# 3. Run the suite.
export BEAR_BASE_URL="$BASE_URL"
cd "$ROOT"
exec npx playwright test "$@"