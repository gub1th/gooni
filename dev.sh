#!/bin/bash
# Boots Gooni dev processes. Prefers cmux (single workspace, three splits);
# falls back to iTerm2 tabs if cmux is not available.
#
# Multi-worktree friendly: derives port offset + DB path from the script's
# directory name. Run from main repo OR any `wt-N` worktree without manual
# port juggling.
#
# Usage: ./dev.sh
#
# Examples:
#   .../gooni/dev.sh         → BE 8000, FE 5173, DS 8100, db/gooni.db
#   .../wt-1/dev.sh          → BE 8001, FE 5174, DS 8101, db/gooni-wt-1.db
#   .../wt-2/dev.sh          → BE 8002, FE 5175, DS 8102, db/gooni-wt-2.db

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NAME=$(basename "$DIR")
# First number anywhere in the dir name → offset. No number → 0 (main repo).
NUM=$(echo "$NAME" | grep -oE '[0-9]+' | head -1)
OFFSET=${NUM:-0}

FE_PORT=$((5173 + OFFSET))
BE_PORT=$((8000 + OFFSET))
DS_PORT=$((8100 + OFFSET))
# Per-worktree DB so concurrent worktrees don't trample each other's state.
# Main repo (no number) keeps the canonical gooni.db.
if [ -z "$NUM" ]; then
  DB_FILE="db/gooni.db"
else
  DB_FILE="db/gooni-${NAME}.db"
fi
FE_URL="http://localhost:${FE_PORT}"
API_URL="http://localhost:${BE_PORT}"
DB_URL="sqlite:///./${DB_FILE}"

# Locate venv. Worktrees usually don't have their own — fall back to peer
# main-repo venv at ../../../gooni/venv (matches `.worktrees/gooni/wt-N` layout).
MAIN_REPO=""
if [ -f "$DIR/venv/bin/activate" ]; then
  VENV="$DIR/venv/bin/activate"
elif [ -f "$DIR/../../../gooni/venv/bin/activate" ]; then
  MAIN_REPO="$(cd "$DIR/../../../gooni" && pwd)"
  VENV="$MAIN_REPO/venv/bin/activate"
else
  echo "ERROR: no venv found at $DIR/venv or peer main repo. Aborting."
  exit 1
fi

# Symlink gitignored config files from main repo when missing.
# .env carries OPENAI_API_KEY etc; .mcp.json drives /public/mcp.
# Symlink (not copy) so editing in main propagates to all worktrees.
link_from_main() {
  local file="$1"
  if [ -n "$MAIN_REPO" ] && [ ! -e "$DIR/$file" ] && [ -f "$MAIN_REPO/$file" ]; then
    ln -s "$MAIN_REPO/$file" "$DIR/$file"
    echo "  linked:    $file → main repo"
  fi
}
link_from_main ".env"
link_from_main ".mcp.json"

echo "Worktree: ${NAME} (offset ${OFFSET})"
echo "  FE:        ${FE_URL}"
echo "  BE:        ${API_URL}"
echo "  Datasette: http://localhost:${DS_PORT}"
echo "  DB:        ${DB_FILE}"
echo "  venv:      ${VENV}"

# Make sure DB dir exists before sqlite tries to open it.
mkdir -p "$DIR/db"

# Kill only the ports we're about to claim — leaves other worktrees alone.
echo "Clearing ports ${BE_PORT}, ${FE_PORT}, ${DS_PORT}..."
lsof -ti:${BE_PORT} | xargs kill -9 2>/dev/null
lsof -ti:${FE_PORT} | xargs kill -9 2>/dev/null
lsof -ti:${DS_PORT} | xargs kill -9 2>/dev/null

sleep 1

BACKEND_CMD="cd '$DIR' && source '${VENV}' && DATABASE_URL='${DB_URL}' ALLOWED_ORIGINS='${FE_URL}' uvicorn app.main:app --reload --port ${BE_PORT}"
FRONTEND_CMD="cd '$DIR/frontend' && VITE_API_URL='${API_URL}' npm run dev -- --port ${FE_PORT}"
DATASETTE_CMD="cd '$DIR' && source '${VENV}' && datasette '${DB_FILE}' -p ${DS_PORT}"

if command -v cmux >/dev/null 2>&1; then
  # ----- cmux path -----
  # If invoked from inside a cmux pane, add a new tab to the CURRENT workspace
  # and split that tab into BE/FE/DS. Keeps the user's shell pane untouched
  # and reuses the workspace's title (e.g. "Chat Eval Loop") in the sidebar.
  # If invoked from outside cmux, fall back to spawning a new workspace.

  send_cmd() {
    # send_cmd <workspace> <surface> <cmd>
    cmux send --workspace "$1" --surface "$2" "$3" >/dev/null
    cmux send-key --workspace "$1" --surface "$2" Enter >/dev/null
  }

  if [[ -n "${CMUX_WORKSPACE_ID:-}" ]]; then
    WS="$CMUX_WORKSPACE_ID"

    # Make a new tab to the right of the current one in this workspace.
    # Output: "OK action=new_terminal_right tab=tab:N workspace=ws created=tab:M"
    # `created=tab:M` and `surface:M` reference the same entity, but `send`
    # and `new-split` only accept the `surface:` form — rewrite the prefix.
    TAB_OUT=$(cmux tab-action --action new-terminal-right --workspace "$WS")
    CREATED_TAB=$(echo "$TAB_OUT" | tr ' ' '\n' | awk -F= '/^created=/{print $2}')
    if [[ -z "$CREATED_TAB" ]]; then
      echo "Failed to create dev tab: $TAB_OUT" >&2
      exit 1
    fi
    BE_TAB="${CREATED_TAB/#tab:/surface:}"

    cmux tab-action --action rename --tab "$CREATED_TAB" --workspace "$WS" --title "dev: ${NAME}" >/dev/null 2>&1 || true

    # Run backend in the new tab.
    send_cmd "$WS" "$BE_TAB" "$BACKEND_CMD"

    # Split that tab's pane: down → frontend, right → datasette.
    split_in_tab() {
      local dir="$1" cmd="$2"
      local out surface
      out=$(cmux new-split "$dir" --workspace "$WS" --surface "$BE_TAB")
      surface=$(awk '{print $2}' <<< "$out")
      [[ -n "$surface" ]] || { echo "split failed: $out" >&2; return 1; }
      send_cmd "$WS" "$surface" "$cmd"
      # Make sure subsequent splits split off the FRESHLY-created pane, not BE_TAB.
      BE_TAB="$surface"
    }

    BASE_TAB="$BE_TAB"
    BE_TAB="$BASE_TAB"; split_in_tab down  "$FRONTEND_CMD"
    BE_TAB="$BASE_TAB"; split_in_tab right "$DATASETTE_CMD"

    echo "cmux dev tab ready in current workspace ($WS)"
    exit 0
  fi

  # Outside cmux: spawn a fresh workspace.
  WS_OUT=$(cmux new-workspace --name "gooni-${NAME}" --cwd "$DIR" --command "$BACKEND_CMD")
  WS=$(awk '{print $2}' <<< "$WS_OUT")
  if [[ -z "$WS" ]]; then
    echo "Failed to create cmux workspace: $WS_OUT" >&2
    exit 1
  fi
  echo "Created cmux workspace $WS (be-${NAME})"

  split_and_run() {
    local dir="$1" cmd="$2"
    local out surface
    out=$(cmux new-split "$dir" --workspace "$WS")
    surface=$(awk '{print $2}' <<< "$out")
    [[ -n "$surface" ]] || { echo "split failed: $out" >&2; return 1; }
    send_cmd "$WS" "$surface" "$cmd"
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

  -- Tab 1: Backend (uvicorn). DATABASE_URL + ALLOWED_ORIGINS scoped per worktree.
  tell current window
    tell current session
      set name to "be-${NAME}"
      write text "${BACKEND_CMD}"
    end tell

    -- Tab 2: Frontend (vite). VITE_API_URL points at this worktree's BE.
    create tab with default profile
    tell current session
      set name to "fe-${NAME}"
      write text "${FRONTEND_CMD}"
    end tell

    -- Tab 3: Datasette against this worktree's DB.
    create tab with default profile
    tell current session
      set name to "ds-${NAME}"
      write text "${DATASETTE_CMD}"
    end tell
  end tell
end tell
EOF
