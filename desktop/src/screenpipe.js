/**
 * Read Screenpipe's local capture for a focus-session window.
 *
 * Screenpipe (a separate local daemon) records the screen 24/7 into
 * ~/.screenpipe/db.sqlite. Gooni does NOT re-capture — after a focus session
 * stops, this reads exactly that session's [start, stop) window and hands the
 * frames up so `screenevidence.js` can POST them to the backend.
 *
 * WHY THE sqlite3 CLI, not a library. Electron 33 bundles Node 20, which has no
 * `node:sqlite` (that landed in Node 22.5), and `better-sqlite3` is a native
 * addon that needs an electron-rebuild on every Electron bump — exactly the
 * per-build fragility the app sensor avoided by shelling out to `osascript`.
 * macOS ships `/usr/bin/sqlite3` with `-json`, so this spawns it the same way:
 * chrome-free, execFile injected, testable without a real DB.
 *
 * WHY A COPY. Screenpipe writes continuously with WAL, so the live file is
 * frequently locked mid-write. A read-only copy is a consistent snapshot and
 * never contends with the daemon — the exact approach that worked when probing
 * it by hand. The copy is made by the caller (it needs fs); this module only
 * runs SQL against whatever path it is given.
 */

/** The frames a session window produced, oldest first. */
const FRAMES_SQL = `
  SELECT id, timestamp, app_name, window_name, browser_url,
         COALESCE(full_text, accessibility_text) AS text,
         snapshot_path
  FROM frames
  WHERE timestamp >= :start AND timestamp < :until
  ORDER BY timestamp ASC
`;

/** Longest we wait on one query — a wedged sqlite3 must not hang a stop. */
const QUERY_TIMEOUT_MS = 15000;

/**
 * Run one JSON query via the sqlite3 CLI. Resolves to the parsed rows, or
 * throws — the caller decides whether a failed read is fatal (it isn't: a
 * session with no screen data is a session with no summary, not an error).
 *
 * `:start`/`:until` are bound as ISO strings. We do NOT interpolate them into
 * the SQL — sqlite3's `-cmd ".param set"` binds them, so a value can never be
 * read as SQL. (Screenpipe timestamps are ISO UTC, but the binding is the point
 * regardless.)
 *
 * @param {object} opts
 * @param {string} opts.dbPath          path to a readable sqlite file (a copy)
 * @param {string} opts.startIso        window start, inclusive
 * @param {string} opts.untilIso        window end, exclusive
 * @param {Function} opts.execFileImpl  child_process.execFile-compatible
 */
function readWindow({ dbPath, startIso, untilIso, execFileImpl, timeoutMs = QUERY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-json",
      "-cmd",
      `.param set :start '${_q(startIso)}'`,
      "-cmd",
      `.param set :until '${_q(untilIso)}'`,
      dbPath,
      FRAMES_SQL,
    ];
    let settled = false;
    const done = (err, rows) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(rows);
    };
    try {
      execFileImpl("sqlite3", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return done(new Error(`sqlite3 failed: ${(stderr || err.message || "").toString().slice(0, 200)}`));
        const text = String(stdout || "").trim();
        if (!text) return done(null, []); // no rows in the window
        try {
          const parsed = JSON.parse(text);
          done(null, Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          done(new Error(`sqlite3 returned non-JSON: ${e.message}`));
        }
      });
    } catch (e) {
      done(new Error(`sqlite3 spawn failed: ${e.message}`));
    }
  });
}

/** Single-quote escape for the `.param set` command — a stray quote in an ISO
 *  string can't happen, but the binding site is escaped rather than trusted. */
function _q(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Turn Screenpipe rows into the shape the backend's screen-evidence endpoint
 * takes. Pure, so the mapping is testable without a DB.
 *
 * `client_id` is minted from the session id + Screenpipe's own frame id, so a
 * re-posted window dedups server-side (the backend's UNIQUE boundary) — the
 * same idempotency the interval sensors use.
 *
 * A row with NO text is kept: the app/window/url still place the moment on the
 * timeline, and Phase 2's image may yet attach to it. Empty strings become
 * null so the backend stores a clean absence rather than "".
 */
function toEvidence(sessionId, rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.id == null || !r.timestamp) continue;
    out.push({
      client_id: `sp-${sessionId}-${r.id}`,
      ts: r.timestamp,
      app: _nz(r.app_name),
      window_name: _nz(r.window_name),
      url: _nz(r.browser_url),
      title: _nz(r.window_name),
      text: _nz(r.text),
      // Phase 2 ONLY, and NEVER sent to the backend: the local JPEG path the
      // orchestrator uploads to R2, then strips before POSTing the text frame.
      // Shipping a local filesystem path to the cloud would leak the directory
      // layout for no reason.
      imagePath: _nz(r.snapshot_path),
    });
  }
  return out;
}

function _nz(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
}

module.exports = { readWindow, toEvidence, FRAMES_SQL, QUERY_TIMEOUT_MS };
