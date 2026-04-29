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
  # Always spawn a fresh workspace named after the source workspace
  # (e.g. "dev: gooni: fix-up-focuses"). Earlier versions tried to add a
  # tab + splits to the CURRENT workspace, but cmux's tab/pane model
  # doesn't allow nested panes inside a tab — splits ended up scattered
  # across the user's working pane. A separate workspace gives the dev
  # processes a clean BE/FE/DS layout the user can switch to via the
  # sidebar, with no pollution of the source workspace.

  send_cmd() {
    # send_cmd <workspace> <surface> <cmd>
    cmux send --workspace "$1" --surface "$2" "$3" >/dev/null
    cmux send-key --workspace "$1" --surface "$2" Enter >/dev/null
  }

  # If we're inside cmux, derive the parent workspace title for naming.
  # `--id-format uuids` produces lines like:
  #   "  <uuid>  <title>"             (non-selected)
  #   "* <uuid>  <title>  [selected]" (currently selected)
  # so we strip leading "*" / whitespace, match the UUID prefix, and
  # trim a trailing "[selected]" token if present.
  PARENT_TITLE=""
  if [[ -n "${CMUX_WORKSPACE_ID:-}" ]]; then
    PARENT_TITLE=$(cmux --id-format uuids list-workspaces 2>/dev/null \
      | awk -v id="$CMUX_WORKSPACE_ID" '
          { sub(/^[ \t*]+/, "");
            if (substr($0, 1, length(id)) == id) {
              rest = substr($0, length(id) + 1);
              sub(/^[ \t]+/, "", rest);
              sub(/[ \t]+\[selected\]$/, "", rest);
              print rest; exit;
            }
          }')
  fi

  if [[ -n "$PARENT_TITLE" ]]; then
    WS_NAME="dev: ${PARENT_TITLE}"
  else
    WS_NAME="dev: ${NAME}"
  fi

  # Spawn the new workspace running BE as its initial command.
  WS_OUT=$(cmux new-workspace --name "$WS_NAME" --cwd "$DIR" --command "$BACKEND_CMD")
  WS=$(awk '{print $2}' <<< "$WS_OUT")
  if [[ -z "$WS" ]]; then
    echo "Failed to create cmux workspace: $WS_OUT" >&2
    exit 1
  fi
  echo "Created cmux workspace $WS — \"$WS_NAME\""

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
