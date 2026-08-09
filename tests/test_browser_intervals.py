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

    # ── a collision MID-BATCH must not discard the rows already inserted ─────
    # The pre-filter is only a fast path: two concurrent flushes of the same
    # buffer can have one commit a client_id between the other's IN query and
    # its own insert, so the UNIQUE constraint is what actually fires. Hiding
    # one id from the pre-filter reproduces exactly that ordering.
    #
    # The bug this pins: unwinding the loser with a plain db.rollback() throws
    # away every row inserted earlier in the batch while `stored` goes on
    # naming them — and the extension deletes exactly those ids from its
    # buffer, so the intervals are gone and reported as delivered.
    bas.ingest_batch(db, [_iv("racer")])
    _real_existing = bas._existing_client_ids
    bas._existing_client_ids = lambda s, ids: _real_existing(s, ids) - {"racer"}
    try:
        r5 = bas.ingest_batch(
            db, [_iv("pre-collision"), _iv("racer"), _iv("post-collision")]
        )
    finally:
        bas._existing_client_ids = _real_existing

    check(r5["duplicates"] == 1, f"collision not counted as a duplicate: {r5}")
    check(
        sorted(r5["stored_ids"]) == ["post-collision", "pre-collision"],
        f"stored_ids after mid-batch collision: {r5}",
    )
    # Read through a SECOND session: the ingesting session's identity map would
    # happily hand back a row that was rolled back and never committed, which
    # is the very thing being tested.
    verify = SessionLocal()
    try:
        landed = {
            cid
            for (cid,) in verify.query(BrowserInterval.client_id).filter(
                BrowserInterval.client_id.in_(
                    ["pre-collision", "racer", "post-collision"]
                )
            )
        }
    finally:
        verify.close()
    check("pre-collision" in landed,
          f"row inserted BEFORE the collision was discarded: {landed}")
    check("post-collision" in landed,
          f"row inserted AFTER the collision was discarded: {landed}")
    check("racer" in landed, "the pre-existing row was lost by the collision")
    check(
        set(r5["stored_ids"]) <= landed,
        f"reported accepted an id that never committed: {r5['stored_ids']} vs {landed}",
    )

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

    # ── a non-string url/path costs THAT ROW, not the batch ──────────────────
    # `path`/`url` are the only fields that reach scrub_url uncoerced, and
    # urlsplit() on a non-string raises AttributeError/TypeError — which the
    # route's `except ValueError -> 400` does not catch, so the whole batch
    # 500s. That is the one response the extension RETAINS on, so a hand-rolled
    # client sending an int url would wedge its buffer behind a poison batch
    # forever. The contract is per-row: a malformed row is rejected with a
    # reason and its neighbours still land.
    try:
        typed = bas.ingest_batch(
            db,
            [
                _iv("int-url", url=1234),
                _iv("list-path", path=["/a", "/b"]),
                _iv("dict-url", url={"href": "https://x.com"}),
                _iv("bool-path", path=True),
                _iv("survivor"),
            ],
        )
    except Exception as e:  # noqa: BLE001 — a raise here IS the regression
        typed = None
        fails.append(f"non-string url/path raised instead of rejecting: {type(e).__name__}: {e}")
        db.rollback()

    if typed is not None:
        check(typed["accepted"] == 1, f"only the valid row should land: {typed}")
        by_id = {r["client_id"]: r["reason"] for r in typed["rejected"]}
        check(by_id.get("int-url") == "bad_url", f"int url reason: {by_id}")
        check(by_id.get("dict-url") == "bad_url", f"dict url reason: {by_id}")
        check(by_id.get("list-path") == "bad_path", f"list path reason: {by_id}")
        check(by_id.get("bool-path") == "bad_path", f"bool path reason: {by_id}")
        check("survivor" not in by_id, f"valid row was rejected: {by_id}")
        check(
            db.query(BrowserInterval).filter_by(client_id="survivor").count() == 1,
            "the valid row in a batch with a typed-wrong row was lost",
        )
        check(
            db.query(BrowserInterval)
            .filter(BrowserInterval.client_id.in_(["int-url", "list-path", "dict-url", "bool-path"]))
            .count()
            == 0,
            "a rejected row was stored anyway",
        )

    # ── an unparseable TIMESTAMP costs its row, not the batch ────────────────
    # Same contract hole as the non-string url above, one field over. The
    # numeric branches of _parse_dt call datetime.fromtimestamp, which raises
    # OverflowError for an out-of-range epoch (a plain JSON integer — no exotic
    # encoding needed) and ValueError for NaN, which json.loads accepts as a
    # bare literal. Unguarded, the first escapes as a 500 the extension RETAINS
    # and retries forever, and the second as a 400 — which is in the client's
    # drop-allowlist, so it throws away every valid row in the batch too.
    try:
        clocks = bas.ingest_batch(
            db,
            [
                {"client_id": "epoch-overflow", "host": "a.com",
                 "started_at": 10 ** 20,
                 "ended_at": (T0 + timedelta(seconds=60)).isoformat()},
                {"client_id": "epoch-negative", "host": "a.com",
                 "started_at": -1e20,
                 "ended_at": (T0 + timedelta(seconds=60)).isoformat()},
                {"client_id": "nan-end", "host": "a.com",
                 "started_at": T0.isoformat(), "ended_at": float("nan")},
                {"client_id": "inf-start", "host": "a.com",
                 "started_at": float("inf"),
                 "ended_at": (T0 + timedelta(seconds=60)).isoformat()},
                _iv("clock-survivor", start=T0 + timedelta(minutes=11)),
            ],
        )
    except Exception as e:  # noqa: BLE001 — a raise here IS the regression
        clocks = None
        fails.append(f"unparseable timestamp raised instead of rejecting: {type(e).__name__}: {e}")
        db.rollback()

    if clocks is not None:
        by_id = {r["client_id"]: r["reason"] for r in clocks["rejected"]}
        check(clocks["accepted"] == 1, f"only the valid row should land: {clocks}")
        check(by_id.get("epoch-overflow") == "bad_started_at", f"overflow epoch: {by_id}")
        check(by_id.get("epoch-negative") == "bad_started_at", f"negative epoch: {by_id}")
        check(by_id.get("inf-start") == "bad_started_at", f"infinite epoch: {by_id}")
        check(by_id.get("nan-end") == "bad_ended_at", f"NaN end: {by_id}")
        check(
            db.query(BrowserInterval).filter_by(client_id="clock-survivor").count() == 1,
            "the valid row in a batch with an unparseable timestamp was lost",
        )

    # …and a REAL epoch still parses — the guard must not eat the happy path.
    epoch_start = datetime(2026, 8, 8, 17, 0, tzinfo=timezone.utc)
    bas.ingest_batch(
        db,
        [{"client_id": "epoch-ok", "host": "a.com",
          "started_at": epoch_start.timestamp(),
          "ended_at": epoch_start.timestamp() + 60}],
    )
    ep = db.query(BrowserInterval).filter_by(client_id="epoch-ok").one()
    check(ep.started_at == datetime(2026, 8, 8, 17, 0), f"epoch parse: {ep.started_at}")
    check(ep.duration_sec == 60.0, f"epoch duration: {ep.duration_sec}")

    # ── an ended_at in the future is rejected, not just started_at ────────────
    # An NTP correction or a laptop resume mid-interval stamps startedAt on the
    # old clock and endedAt on the new one. A 3h forward jump sits under the 6h
    # MAX_INTERVAL_SEC ceiling, so nothing else catches it and the row stores as
    # a real three-hour focus block ending three hours from now.
    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    skew = bas.ingest_batch(
        db,
        [
            _iv("clock-jump", start=now_naive - timedelta(minutes=1), seconds=3 * 3600),
            _iv("skew-survivor", start=T0 + timedelta(minutes=12)),
        ],
    )
    check(skew["accepted"] == 1, f"only the sane row should land: {skew}")
    check(
        {r["client_id"]: r["reason"] for r in skew["rejected"]}.get("clock-jump") == "future",
        f"a future ended_at must reject as `future`: {skew['rejected']}",
    )
    check(
        db.query(BrowserInterval).filter_by(client_id="clock-jump").count() == 0,
        "an interval ending hours in the future was stored",
    )
    check(
        db.query(BrowserInterval).filter_by(client_id="skew-survivor").count() == 1,
        "the sane row alongside a clock-jumped one was lost",
    )

    # ── a valid row with NO url/path at all is still fine ────────────────────
    bas.ingest_batch(db, [{"client_id": "bare", "host": "example.com",
                           "started_at": T0.isoformat(),
                           "ended_at": (T0 + timedelta(seconds=60)).isoformat()}])
    bare = db.query(BrowserInterval).filter_by(client_id="bare").one()
    check(bare.url is None and bare.path is None, f"absent url/path invented: {bare.url} {bare.path}")

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

    # ── the floor covers `path` too, not just `url` ──────────────────────────
    # The extension only ever sends `u.pathname`, but this floor exists for the
    # clients that AREN'T the extension. One that puts its query string in
    # `path` must not get under it — the docstring promises a hand-rolled
    # client can't park an OAuth code in the log, and that has to be true of
    # every field that holds one.
    bas.ingest_batch(
        db,
        [
            _iv(
                "path-oauth",
                host="app.example.com",
                path="/callback?code=abc123&next=/home#access_token=sekrit",
                url="https://app.example.com/callback",
            )
        ],
    )
    pth = db.query(BrowserInterval).filter_by(client_id="path-oauth").one()
    check("abc123" not in (pth.path or ""), f"oauth code stored in path: {pth.path}")
    check("sekrit" not in (pth.path or ""), f"fragment token stored in path: {pth.path}")
    check("code=REDACTED" in pth.path, f"path code not redacted: {pth.path}")
    check("next=" in pth.path, f"innocent path param dropped: {pth.path}")

    # …and an ordinary path is left exactly as it came in.
    bas.ingest_batch(db, [_iv("plain-path", path="/problems/two-sum/")])
    check(
        db.query(BrowserInterval).filter_by(client_id="plain-path").one().path
        == "/problems/two-sum/",
        "a query-less path must round-trip untouched",
    )

    # ── THE CREDENTIAL-NAME TABLE ────────────────────────────────────────────
    # The regression net, not an illustration. This list has broken in three
    # different directions: substring matching over-redacted (`auth`→`author`,
    # `sig`→`assignee`), pure segment matching leaked every camelCase name
    # (`accessToken` stored a live bearer token verbatim), and whole-name-only
    # would have dropped `api_key`. Hence three checks — squashed whole-name,
    # whole-name, segment — and every name pinned by literal, in the SAME ORDER
    # as the identical table in extension/tests/scrub.test.js. The two must
    # agree case for case; a floor that matched differently would not be one.
    kept_names = [
        "assignee", "author", "authors", "design", "designer", "insight",
        "zip_code", "country-code", "error_code", "promo_code",
        "sort_key", "product_key", "us_state", "page_state",
        # Extras beyond the pinned list, same spirit.
        "zipcode", "keyword", "real_estate", "v", "next", "t",
    ]
    secret_names = [
        "auth", "sig", "token", "password", "secret", "code", "key", "state",
        "auth_token", "access_token", "id_token", "api_key", "x-amz-signature",
        "accessToken", "idToken", "authToken", "sessionId", "clientSecret",
        "jsessionid", "phpsessid", "csrftoken",
        "x-api-key", "xApiKey", "X-Api-Key", "x_api_key", "x-functions-key",
        "subscription-key",
        # Extras beyond the pinned list, same spirit.
        "pwd", "otp", "passwd", "session", "apikey", "authorization",
        "credential", "signature", "client_secret", "session_id",
        "X-Amz-Security-Token", "refresh_token", "my_auth_token",
    ]
    for name in kept_names:
        check(bas._is_secret_param(name) is False, f"{name} must NOT be a secret param")
        out = bas.scrub_url(f"https://example.com/x?{name}=dani")
        check(out.endswith("=dani"), f"{name} lost its value: {out}")
    for name in secret_names:
        check(bas._is_secret_param(name) is True, f"{name} MUST be a secret param")
        out = bas.scrub_url(f"https://example.com/x?{name}=sekrit")
        check("sekrit" not in out, f"{name} leaked its value: {out}")
        check("REDACTED" in out, f"{name} not marked redacted: {out}")

    # Each of the three checks is load-bearing on its own.
    # 1. squashed whole-name — the only thing that catches a name with no
    #    boundary at all, and what keeps api_key covered now `key` isn't a segment.
    check(bas._is_secret_param("jsessionid") is True, "squashed check dead")
    check(bas._is_secret_param("apiKey") is True, "apiKey missed")
    # The `x-` prefixed family reaches this check and NOTHING else: `key` is
    # whole-name-only (check 2) and absent from the segment set (check 3), so
    # `x-api-key` has no matching segment and squashes to `xapikey`, not
    # `apikey`. Entries in the set must therefore be pre-squashed.
    check(bas._is_secret_param("x-api-key") is True, "x-api-key leaked")
    check(bas._is_secret_param("x-functions-key") is True, "x-functions-key leaked")
    check(bas._is_secret_param("subscription-key") is True, "subscription-key leaked")
    # 2. whole-name only — bare OAuth params go, their compounds stay.
    check(bas._is_secret_param("code") is True, "bare code kept")
    check(bas._is_secret_param("zip_code") is False, "zip_code over-redacted")
    check(bas._is_secret_param("sort_key") is False, "sort_key over-redacted")
    check(bas._is_secret_param("us_state") is False, "us_state over-redacted")
    # 3. segments, incl. camelCase + digit boundaries — a compound nobody listed.
    check(bas._is_secret_param("gh-session-key") is True, "compound secret missed")
    check(bas._is_secret_param("sha256Sig") is True, "digit-boundary secret missed")
    # …without touching a compound of innocent words.
    check(bas._is_secret_param("sort-by-author") is False, "innocent compound redacted")

    # …and it holds through the ingest path, not just the helper.
    bas.ingest_batch(
        db,
        [_iv("gh-filter", host="github.com", path="/issues",
             url="https://github.com/issues?assignee=dani&author=dani&zip_code=94107"
                 "&code=abc123&accessToken=sekrit&jsessionid=deadbeef"
                 "&x-api-key=LIVEKEY123")],
    )
    gh = db.query(BrowserInterval).filter_by(client_id="gh-filter").one()
    check("assignee=dani" in gh.url, f"assignee over-redacted on ingest: {gh.url}")
    check("author=dani" in gh.url, f"author over-redacted on ingest: {gh.url}")
    check("zip_code=94107" in gh.url, f"zip_code over-redacted on ingest: {gh.url}")
    check("code=REDACTED" in gh.url, f"oauth code survived ingest: {gh.url}")
    check("sekrit" not in gh.url, f"camelCase bearer token stored: {gh.url}")
    check("deadbeef" not in gh.url, f"session id stored: {gh.url}")
    check("LIVEKEY123" not in gh.url, f"x-api-key stored: {gh.url}")

    # ── HTTP-basic userinfo never lands in the log ───────────────────────────
    # A `user:password@` is a strictly stronger credential than an OAuth code,
    # and it got under this floor twice over: the no-query/no-fragment early
    # return handed the URL straight back, and urlunsplit re-emitted netloc
    # verbatim when it didn't. Both cases are pinned below.
    for raw in (
        "https://alice:hunter2@intranet.example.com/dashboard",
        "https://alice:hunter2@intranet.example.com/dashboard?tab=1",
        "https://alice@intranet.example.com/dashboard",
    ):
        out = bas.scrub_url(raw)
        check("hunter2" not in out, f"password stored verbatim: {out}")
        check("alice" not in out, f"username stored verbatim: {out}")
        check("intranet.example.com" in out, f"host lost with the credentials: {out}")
        check("REDACTED@" in out, f"credentialed URL not marked: {out}")
    # A non-secret param alongside the credentials still survives.
    check("tab=1" in bas.scrub_url("https://alice:hunter2@x.com/d?tab=1"),
          "innocent param dropped with the userinfo")
    # Host and port carry through exactly — case, port, IPv6 brackets.
    check(
        bas.scrub_url("https://u:p@Host.Example.com:8443/x")
        == "https://REDACTED@Host.Example.com:8443/x",
        f"host/port mangled: {bas.scrub_url('https://u:p@Host.Example.com:8443/x')}",
    )
    check(
        bas.scrub_url("https://u:p@[::1]:8443/x") == "https://REDACTED@[::1]:8443/x",
        f"IPv6 literal mangled: {bas.scrub_url('https://u:p@[::1]:8443/x')}",
    )
    # A URL with no credentials is returned untouched, not rebuilt.
    check(bas.scrub_url("https://example.com/a/b") == "https://example.com/a/b",
          "a clean URL must round-trip byte-for-byte")

    bas.ingest_batch(
        db,
        [_iv("basic-auth", host="intranet.example.com", path="/dashboard",
             url="https://alice:hunter2@intranet.example.com/dashboard")],
    )
    ba = db.query(BrowserInterval).filter_by(client_id="basic-auth").one()
    check("hunter2" not in (ba.url or ""), f"basic-auth password stored: {ba.url}")

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
