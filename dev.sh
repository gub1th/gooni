#!/bin/bash
# Boots Gooni dev processes as a cmux workspace with three splits.
# Falls back to iTerm2 if cmux is not available.
# Usage: ./dev.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Clearing ports 8000 and 5173..."
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
sleep 1

BACKEND_CMD="source venv/bin/activate && uvicorn app.main:app --reload"
FRONTEND_CMD="cd '$DIR/frontend' && npm run dev"
DATASETTE_CMD="source venv/bin/activate && datasette db/gooni.db -p 8002"

if command -v cmux >/dev/null 2>&1; then
  # ----- cmux path -----

  # Spawn workspace running the backend. Output: "OK workspace:N"
  WS_OUT=$(cmux new-workspace --name "gooni" --cwd "$DIR" --command "$BACKEND_CMD")
  WS=$(awk '{print $2}' <<< "$WS_OUT")
  if [[ -z "$WS" ]]; then
    echo "Failed to create cmux workspace: $WS_OUT" >&2
    exit 1
  fi
  echo "Created workspace $WS (backend)"

  # Helper: split current pane in $WS, run a command in the new surface.
  split_and_run() {
    local dir="$1" cmd="$2"
    local out surface
    out=$(cmux new-split "$dir" --workspace "$WS")
    # Output: "OK surface:M workspace:N"
    surface=$(awk '{print $2}' <<< "$out")
    [[ -n "$surface" ]] || { echo "split failed: $out" >&2; return 1; }
    cmux send --workspace "$WS" --surface "$surface" "$cmd" >/dev/null
    cmux send-key --workspace "$WS" --surface "$surface" Enter >/dev/null
  }

  split_and_run down  "$FRONTEND_CMD"
  split_and_run right "$DATASETTE_CMD"

  echo "cmux workspace ready: backend / frontend / datasette"
  exit 0
fi

# ----- iTerm2 fallback (original behavior) -----
osascript <<EOF
tell application "iTerm2"
  create window with default profile

  tell current window
    tell current session
      set name to "backend"
      write text "cd '$DIR' && $BACKEND_CMD"
    end tell

    create tab with default profile
    tell current session
      set name to "frontend"
      write text "$FRONTEND_CMD"
    end tell

    create tab with default profile
    tell current session
      set name to "datasette"
      write text "cd '$DIR' && $DATASETTE_CMD"
    end tell
  end tell
end tell
EOF
