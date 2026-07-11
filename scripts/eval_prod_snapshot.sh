#!/usr/bin/env bash
# Pull prod sqlite snapshot from Fly and run the orchestrator eval against it.
#
# Why: the in-process eval harness (evals/run_orchestrator.py) normally points
# at a scratch DB so synthetic cases run clean. That gives us "ideal-state"
# scores. But real prod has hundreds of memories, live promises, and
# trackable history — all of which actually shape the master prompt at chat
# time. Score against prod state = the number that actually matters.
#
# Snapshot is git-ignored (db/gooni-prod-snapshot.db) and contains all user
# data. Don't commit it.
#
# Usage:
#   ./scripts/eval_prod_snapshot.sh                      # pull + eval
#   ./scripts/eval_prod_snapshot.sh --skip-pull          # reuse last snapshot
#   ./scripts/eval_prod_snapshot.sh --case 011           # single case
#   ./scripts/eval_prod_snapshot.sh --baseline           # save baseline JSON
#                                                         (auto-labels w/ date)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SNAPSHOT_PATH="./db/gooni-prod-snapshot.db"
FLY_APP="gooni-bot"
FLY_DB_PATH="/app/db/gooni.db"

SKIP_PULL=0
EVAL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-pull) SKIP_PULL=1 ;;
    *) EVAL_ARGS+=("$arg") ;;
  esac
done

if [[ "$SKIP_PULL" -eq 0 ]]; then
  echo ">> pulling fresh snapshot from $FLY_APP:$FLY_DB_PATH"
  mkdir -p ./db
  flyctl ssh sftp get "$FLY_DB_PATH" "$SNAPSHOT_PATH" -a "$FLY_APP"
fi

if [[ ! -f "$SNAPSHOT_PATH" ]]; then
  echo "!! no snapshot at $SNAPSHOT_PATH — run without --skip-pull first"
  exit 1
fi

# Auto-add a dated label when --baseline is passed and no explicit --label.
HAS_BASELINE=0
HAS_LABEL=0
for arg in "${EVAL_ARGS[@]:-}"; do
  [[ "$arg" == "--baseline" ]] && HAS_BASELINE=1
  [[ "$arg" == --label* ]] && HAS_LABEL=1
done
if [[ "$HAS_BASELINE" -eq 1 && "$HAS_LABEL" -eq 0 ]]; then
  EVAL_ARGS+=("--label" "prod_$(date +%Y-%m-%d)")
fi

echo ">> eval against prod snapshot ($SNAPSHOT_PATH)"
EVAL_DATABASE_URL="sqlite:///$SNAPSHOT_PATH" \
  python -m evals.run_orchestrator "${EVAL_ARGS[@]:-}"
