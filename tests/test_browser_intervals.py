"""Browser-attention ingest net — idempotency, validation, URL scrubbing.

No LLM, no HTTP: exercises browser_activity_service against a temp SQLite db
(same harness as test_event / test_overlay). The load-bearing assertion is
replay: the extension retries a batch whenever a flush's response is lost, so
an ingest that double-counts would inflate every attention number forever.

Usage:
  source venv/bin/activate
  python tests/test_browser_intervals.py
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

from app.db.database import SessionLocal, engine  # noqa: E402
from app.db.models import Base, BrowserInterval  # noqa: E402
from app.services import browser_activity_service as bas  # noqa: E402

T0 = datetime(2026, 8, 8, 17, 0, 0)


def _iv(client_id, *, host="leetcode.com", path="/problems/two-sum/",
        url=None, start=T0, seconds=60, **extra):
    return {
        "client_id": client_id,
        "host": host,
        "path": path,
        "url": url if url is not None else f"https://{host}{path}",
        "title": "Two Sum",
        "started_at": start.isoformat(),
        "ended_at": (start + timedelta(seconds=seconds)).isoformat(),
        "end_reason": "tab_change",
        **extra,
    }


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    fails: list[str] = []

    def check(cond: bool, msg: str):
        if not cond:
            fails.append(msg)

    # ── a batch lands, duration is computed server-side ──────────────────────
    r = bas.ingest_batch(db, [_iv("a"), _iv("b", start=T0 + timedelta(minutes=5))])
    check(r["accepted"] == 2, f"expected 2 accepted, got {r}")
    check(r["duplicates"] == 0, f"unexpected duplicates: {r}")
    row = db.query(BrowserInterval).filter_by(client_id="a").one()
    check(row.duration_sec == 60.0, f"duration {row.duration_sec} != 60")
    check(row.host == "leetcode.com", f"host {row.host}")
    check(row.path == "/problems/two-sum/", f"path {row.path}")

    # ── REPLAY: the same batch twice must not double-count ───────────────────
    r2 = bas.ingest_batch(db, [_iv("a"), _iv("b", start=T0 + timedelta(minutes=5))])
    check(r2["accepted"] == 0, f"replay accepted rows: {r2}")
    check(r2["duplicates"] == 2, f"replay duplicates {r2['duplicates']} != 2")
    check(db.query(BrowserInterval).count() == 2, "replay created rows")

    # ── a partially-overlapping retry stores only the new interval ───────────
    r3 = bas.ingest_batch(db, [_iv("b", start=T0 + timedelta(minutes=5)), _iv("c")])
    check(r3["accepted"] == 1 and r3["duplicates"] == 1, f"partial retry: {r3}")
    check(db.query(BrowserInterval).count() == 3, "partial retry row count")

    # ── a batch repeating an id INSIDE itself is the same bug, one layer in ──
    r4 = bas.ingest_batch(db, [_iv("d"), _iv("d")])
    check(r4["accepted"] == 1, f"intra-batch dupe: {r4}")
    check(db.query(BrowserInterval).filter_by(client_id="d").count() == 1, "intra-batch dupe row")

    # ── client-claimed duration is ignored; clocks are read, not arithmetic ──
    bas.ingest_batch(db, [_iv("e", seconds=30, duration_sec=99999)])
    check(db.query(BrowserInterval).filter_by(client_id="e").one().duration_sec == 30.0,
          "client duration_sec was trusted")

    # ── validation: each bad row is rejected with a reason, batch survives ───
    bad = bas.ingest_batch(
        db,
        [
            {"host": "x.com", "started_at": T0.isoformat(), "ended_at": T0.isoformat()},  # no id
            _iv("no-host", host=""),
            _iv("backwards", seconds=-60),
            _iv("blip", seconds=0.2),
            _iv("marathon", seconds=7 * 3600),
            _iv("bad-clock", start=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=2)),
            _iv("good"),
        ],
    )
    reasons = {r["reason"] for r in bad["rejected"]}
    check(bad["accepted"] == 1, f"one good row should land: {bad}")
    for want in ("missing_client_id", "missing_host", "negative_duration",
                 "too_short", "too_long", "future"):
        check(want in reasons, f"missing rejection reason {want}: {reasons}")

    # ── scrub backstop: credentials never land even if the client sent them ──
    bas.ingest_batch(
        db,
        [
            _iv(
                "oauth",
                host="app.example.com",
                path="/callback",
                url="https://app.example.com/callback?code=abc123&next=/home&access_token=sekrit",
            )
        ],
    )
    stored = db.query(BrowserInterval).filter_by(client_id="oauth").one()
    check("abc123" not in (stored.url or ""), f"oauth code stored: {stored.url}")
    check("sekrit" not in (stored.url or ""), f"access_token stored: {stored.url}")
    check("code=REDACTED" in stored.url, f"code not redacted: {stored.url}")
    # …and a non-secret param survives, or the log says nothing useful.
    check("next=" in stored.url, f"innocent param dropped: {stored.url}")

    # ── a YouTube video id is identity, not a secret ─────────────────────────
    bas.ingest_batch(
        db,
        [_iv("yt", host="www.youtube.com", path="/watch",
             url="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")],
    )
    yt = db.query(BrowserInterval).filter_by(client_id="yt").one()
    check("v=dQw4w9WgXcQ" in yt.url, f"video id scrubbed away: {yt.url}")

    # ── timestamps: offset-aware input normalizes to naive UTC storage ───────
    aware_start = datetime(2026, 8, 8, 10, 0, tzinfo=timezone(timedelta(hours=-7)))
    bas.ingest_batch(
        db,
        [{
            "client_id": "tz",
            "host": "example.com",
            "started_at": aware_start.isoformat(),
            "ended_at": (aware_start + timedelta(seconds=60)).isoformat(),
        }],
    )
    tz_row = db.query(BrowserInterval).filter_by(client_id="tz").one()
    check(tz_row.started_at == datetime(2026, 8, 8, 17, 0), f"tz normalize: {tz_row.started_at}")
    check(tz_row.started_at.tzinfo is None, "stored datetime should be naive UTC")

    # ── the truncated flag round-trips (a salvaged span is not a measured one)
    bas.ingest_batch(db, [_iv("salv", end_reason="truncated", truncated=True)])
    check(db.query(BrowserInterval).filter_by(client_id="salv").one().truncated is True,
          "truncated flag lost")

    # ── batch ceiling ────────────────────────────────────────────────────────
    try:
        bas.ingest_batch(db, [_iv(f"x{i}") for i in range(bas.MAX_BATCH + 1)])
        fails.append("oversized batch should raise ValueError")
    except ValueError:
        pass
    try:
        bas.ingest_batch(db, {"not": "a list"})
        fails.append("non-list intervals should raise ValueError")
    except ValueError:
        pass

    # ── the read-back ────────────────────────────────────────────────────────
    listed = bas.list_intervals(db, limit=5)
    check(len(listed) == 5, f"list limit: {len(listed)}")
    check(listed[0]["started_at"] >= listed[-1]["started_at"], "list not newest-first")

    db.close()
    if fails:
        print("FAIL")
        for f in fails:
            print("  -", f)
        return 1
    print("PASS — browser interval ingest (idempotency, validation, scrubbing)")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        os.unlink(_tmp.name)
    except OSError:
        pass
    sys.exit(code)
