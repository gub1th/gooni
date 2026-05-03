#!/usr/bin/env python3
"""Push Claude Code session usage from this laptop to the Gooni backend.

Walks ``~/.claude/projects/**/*.jsonl``, finds every assistant turn newer
than the last successful upload, and POSTs them in batches to
``$GOONI_API_URL/dashboard/claude-usage/ingest``.

State is kept in ``~/.claude/.gooni_uploader_state.json`` (single
high-watermark timestamp). Backend dedups on ``(session_id, ts)`` so an
overlapping window — e.g. after editing the watermark by hand or running
on a 2nd machine — is harmless.

Run modes:

    # one-shot, defaults to last-watermark or 30d if first run
    python scripts/upload_claude_usage.py

    # explicit window
    python scripts/upload_claude_usage.py --since 2026-04-01

    # full re-upload (slow on big histories)
    python scripts/upload_claude_usage.py --all

    # wire as Claude Code Stop hook in ~/.claude/settings.json:
    #   "hooks": {
    #     "Stop": [
    #       {"command": "python /path/to/scripts/upload_claude_usage.py --quiet"}
    #     ]
    #   }

Required env:
    GOONI_API_URL    — e.g. https://gooni.fly.dev (no trailing slash)
    AUTH_PASSWORD    — same bearer token as dashboard reads
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import urllib.request


PROJECTS_DIR = Path.home() / ".claude" / "projects"
STATE_FILE = Path.home() / ".claude" / ".gooni_uploader_state.json"
BATCH_SIZE = 200


def _walk_jsonls(root: Path) -> Iterator[dict]:
    if not root.exists():
        return
    for path in root.rglob("*.jsonl"):
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def _parse_iso(ts: str) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _load_watermark() -> datetime | None:
    if not STATE_FILE.exists():
        return None
    try:
        data = json.loads(STATE_FILE.read_text())
        return _parse_iso(data.get("watermark") or "")
    except (json.JSONDecodeError, OSError):
        return None


def _save_watermark(ts: datetime) -> None:
    STATE_FILE.write_text(json.dumps({
        "watermark": ts.astimezone(timezone.utc).isoformat(),
    }))


def _collect_turns(since: datetime | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in _walk_jsonls(PROJECTS_DIR):
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message") or {}
        usage = msg.get("usage") or {}
        ts = _parse_iso(entry.get("timestamp") or "")
        if ts is None:
            continue
        if since and ts <= since:
            continue
        in_tok = int(usage.get("input_tokens") or 0)
        out_tok = int(usage.get("output_tokens") or 0)
        cr_tok = int(usage.get("cache_read_input_tokens") or 0)
        cc_tok = int(usage.get("cache_creation_input_tokens") or 0)
        if in_tok == 0 and out_tok == 0 and cr_tok == 0 and cc_tok == 0:
            continue
        out.append({
            "session_id": entry.get("sessionId") or "",
            "ts": ts.astimezone(timezone.utc).isoformat(),
            "model": msg.get("model") or "unknown",
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "cache_read_tokens": cr_tok,
            "cache_creation_tokens": cc_tok,
        })
    return out


def _post_batch(url: str, token: str, turns: list[dict[str, Any]]) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps({"turns": turns}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="ISO date or timestamp (e.g. 2026-04-01). Overrides saved watermark.")
    ap.add_argument("--all", action="store_true", help="Re-upload everything (ignores watermark).")
    ap.add_argument("--quiet", action="store_true", help="Print only on error / success summary.")
    args = ap.parse_args()

    api_url = os.getenv("GOONI_API_URL", "").rstrip("/")
    token = os.getenv("AUTH_PASSWORD")
    if not api_url or not token:
        print("error: set GOONI_API_URL and AUTH_PASSWORD", file=sys.stderr)
        return 2

    if args.all:
        since = None
    elif args.since:
        since = _parse_iso(args.since) or _parse_iso(args.since + "T00:00:00Z")
        if since is None:
            print(f"error: --since={args.since!r} not parseable", file=sys.stderr)
            return 2
    else:
        since = _load_watermark()

    turns = _collect_turns(since=since)
    if not turns:
        if not args.quiet:
            print("no new turns")
        return 0

    # Ascending order so the watermark advance is monotonic.
    turns.sort(key=lambda t: t["ts"])
    url = f"{api_url}/dashboard/claude-usage/ingest"

    sent = 0
    inserted = 0
    for i in range(0, len(turns), BATCH_SIZE):
        batch = turns[i:i + BATCH_SIZE]
        try:
            result = _post_batch(url, token, batch)
        except Exception as e:
            print(f"error posting batch {i // BATCH_SIZE}: {e}", file=sys.stderr)
            return 1
        sent += result.get("received", 0)
        inserted += result.get("inserted", 0)

    last_ts = _parse_iso(turns[-1]["ts"])
    if last_ts:
        _save_watermark(last_ts)

    if not args.quiet or inserted == 0:
        print(f"sent {sent} turns ({inserted} new, {sent - inserted} dupes); watermark → {turns[-1]['ts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
