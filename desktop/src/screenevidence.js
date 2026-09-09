/**
 * The screen-evidence pipeline: notice a focus session stop, read Screenpipe
 * for its window, and POST the frames to Gooni.
 *
 * This is the local half of the feature — Gooni's Fly backend cannot reach
 * ~/.screenpipe, so the shell (which already supervises the focus-cam sidecar)
 * is the only thing that can bridge Screenpipe to the cloud. It runs entirely
 * off injected dependencies (the API client, an execFile for sqlite3, fs reads,
 * a clock) so the whole flow is testable without a real DB, network, or timer.
 *
 * TWO PARTS:
 *   · `SessionWatcher` — polls the server's active session and fires `onStop`
 *     with the session that just ended. Pure transition logic.
 *   · `ingestSession` — for one stopped session: copy Screenpipe's DB, read the
 *     window, POST the text (Phase 1), upload each frame's JPEG (Phase 2).
 *
 * Every failure here is non-fatal by contract. A session with no Screenpipe
 * running, a locked DB, a failed upload — none of them may throw into the
 * shell's lifecycle. The worst case is a session with no summary, which the
 * backend already renders as "no screen data" rather than an error.
 */

/** Frames are POSTed in batches so one huge session isn't a single giant body. */
const BATCH_SIZE = 60;

/**
 * Watches the server's active focus session and reports stops.
 *
 * The server owns the session lifecycle now (`focus_sessions`), and the shell
 * is not told about a stop — so it polls `active` and watches for the id it
 * last saw to disappear or change. When that happens, the PREVIOUS session
 * ended: its window is `[started_at, ended_at]`, recovered by fetching it by id
 * (active no longer carries it). Deliberately id-based, not "active became
 * null": starting a new session ends the old one in the same transaction, so
 * A→B is also a stop of A.
 */
class SessionWatcher {
  /**
   * @param {object} opts
   * @param {() => Promise<object|null>} opts.getActive   server's active session or null
   * @param {(id:number) => Promise<object>} opts.getSession  one session by id
   * @param {(session:object) => Promise<void>} opts.onStop   fired with the stopped session
   * @param {Function} [opts.log]
   */
  constructor({ getActive, getSession, onStop, log = () => {} }) {
    this.getActive = getActive;
    this.getSession = getSession;
    this.onStop = onStop;
    this.log = log;
    this.lastActiveId = null;
    this.running = false;
  }

  /** One poll cycle. Safe to call on an interval; never throws. */
  async tick() {
    if (this.running) return; // don't overlap a slow ingest with the next poll
    this.running = true;
    try {
      let active = null;
      try {
        active = await this.getActive();
      } catch (e) {
        // Offline / backend down. Not a stop — leave lastActiveId as-is so a
        // blip doesn't fabricate a session end.
        return;
      }
      const activeId = active && active.id ? active.id : null;

      if (this.lastActiveId && this.lastActiveId !== activeId) {
        // The session we were watching is no longer the active one → it stopped
        // (either to nothing, or replaced by a new session). Recover its window.
        const stoppedId = this.lastActiveId;
        try {
          const stopped = await this.getSession(stoppedId);
          if (stopped && stopped.state === "stopped") {
            await this.onStop(stopped);
          }
        } catch (e) {
          this.log(`screen-evidence: could not fetch stopped session ${stoppedId}: ${e.message}`);
        }
      }
      this.lastActiveId = activeId;
    } finally {
      this.running = false;
    }
  }
}

/**
 * Ingest one stopped session's screen evidence.
 *
 * @param {object} opts
 * @param {object} opts.session       the stopped session (needs id, started_at, ended_at)
 * @param {object} opts.api           GooniApi
 * @param {string} opts.dbPath        path to Screenpipe's live db.sqlite
 * @param {(src:string,dst:string)=>void} opts.copyFile   fs.copyFileSync-like (WAL-safe snapshot)
 * @param {(p:string)=>Buffer} opts.readFile              fs.readFileSync-like (Phase 2 jpg read)
 * @param {(p:string)=>boolean} opts.exists               fs.existsSync-like
 * @param {string} opts.tmpPath       where to copy the DB (a scratch path)
 * @param {Function} opts.execFileImpl
 * @param {boolean} [opts.uploadFrames]  Phase 2 toggle — upload JPEGs too
 * @param {Function} [opts.fetchImpl]    multipart fetch for uploads
 * @param {Function} [opts.log]
 * @returns {Promise<{frames:number, uploaded:number}>}
 */
async function ingestSession({
  session,
  api,
  dbPath,
  copyFile,
  readFile,
  exists,
  tmpPath,
  execFileImpl,
  uploadFrames = false,
  fetchImpl,
  log = () => {},
}) {
  const { readWindow, toEvidence } = require("./screenpipe");

  if (!session || !session.id || !session.started_at || !session.ended_at) {
    return { frames: 0, uploaded: 0 };
  }
  if (!exists(dbPath)) {
    // No Screenpipe. A session with no screen data is not an error.
    log("screen-evidence: no Screenpipe DB — skipping");
    return { frames: 0, uploaded: 0 };
  }

  // A WAL-safe snapshot. The live file is frequently locked mid-write.
  try {
    copyFile(dbPath, tmpPath);
  } catch (e) {
    log(`screen-evidence: DB copy failed: ${e.message}`);
    return { frames: 0, uploaded: 0 };
  }

  let rows;
  try {
    rows = await readWindow({
      dbPath: tmpPath,
      startIso: session.started_at,
      untilIso: session.ended_at,
      execFileImpl,
    });
  } catch (e) {
    log(`screen-evidence: read failed: ${e.message}`);
    return { frames: 0, uploaded: 0 };
  }

  const evidence = toEvidence(session.id, rows);
  if (evidence.length === 0) {
    log(`screen-evidence: no frames in session ${session.id}'s window`);
    return { frames: 0, uploaded: 0 };
  }

  // Phase 1: POST the text, in batches. `final:true` on the LAST batch triggers
  // the summary server-side. Strip `imagePath` — a local path never goes up.
  const batches = _chunk(evidence, BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const isLast = i === batches.length - 1;
    const wire = batches[i].map(({ imagePath, ...frame }) => frame); // eslint-disable-line no-unused-vars
    try {
      await api.postScreenEvidence(session.id, wire, { final: isLast });
    } catch (e) {
      // A failed batch is retryable next run (client_id dedups), but we stop
      // here rather than pressing on and firing `final` on a partial window.
      log(`screen-evidence: post failed on batch ${i + 1}/${batches.length}: ${e.message}`);
      return { frames: i * BATCH_SIZE, uploaded: 0 };
    }
  }
  log(`screen-evidence: posted ${evidence.length} frames for session ${session.id}`);

  // Phase 2: upload the JPEGs. Best-effort per frame — a missing or unreadable
  // file, or a failed upload, costs that one image and nothing else.
  let uploaded = 0;
  if (uploadFrames) {
    for (const frame of evidence) {
      if (!frame.imagePath || !exists(frame.imagePath)) continue;
      try {
        const bytes = readFile(frame.imagePath);
        await api.uploadScreenFrame(session.id, frame.client_id, bytes, { fetchImpl });
        uploaded++;
      } catch (e) {
        log(`screen-evidence: frame upload failed (${frame.client_id}): ${e.message}`);
      }
    }
    log(`screen-evidence: uploaded ${uploaded}/${evidence.length} frames for session ${session.id}`);
  }

  return { frames: evidence.length, uploaded };
}

function _chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

module.exports = { SessionWatcher, ingestSession, BATCH_SIZE };
