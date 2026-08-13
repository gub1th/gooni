/**
 * A durable JSON document on disk — the shell's answer to the extension's
 * chrome.storage.local, which is atomic and corruption-aware for free.
 *
 * Two rules, both because the thing persisted here is buffered ATTENTION plus
 * the counters that exist to admit losing it (see AppReporter's header: a gap
 * the app admits to is a bug report; a gap it hides is a wrong answer).
 *
 *  - **A write is atomic.** The document goes to a sibling temp file and is
 *    renamed onto the target, so a kill, a panic or a power cut leaves either
 *    the whole old document or the whole new one — never a truncated one. The
 *    temp file is in the SAME directory on purpose: rename is only atomic
 *    within a filesystem. In-place `writeFileSync` had exactly the failure this
 *    prevents, and the crash that causes it is the same crash the open-interval
 *    salvage anchor exists for, so both failed together.
 *  - **A missing file is normal; an unreadable one is LOUD.** Every first
 *    launch reads nothing, so that path stays quiet. Unreadable bytes are a
 *    real loss of a buffered backlog, so they are PRESERVED alongside
 *    (`<name>.corrupt-<stamp>`) rather than overwritten, logged, and COUNTED —
 *    the count is the number of quarantine files, which survives losing the
 *    very state file the counters lived in. That count is a THIRD cause of
 *    loss, distinct from the reporter's `dropped` (buffer overflow) and
 *    `refused` (the server refused the batch), and it is reported separately
 *    because the tray labels those two specifically.
 *
 * `fsImpl`, `now` and `log` are injected so all of it is testable without
 * Electron and without waiting for a real crash.
 */

const nodeFs = require("node:fs");
const nodePath = require("node:path");

const CORRUPT_SUFFIX = ".corrupt-";
const TMP_SUFFIX = ".tmp";

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {object} opts
 * @param {string} opts.dir      directory holding the document
 * @param {string} opts.name     file name within it
 * @param {typeof nodeFs} [opts.fsImpl]
 * @param {() => number} [opts.now]
 * @param {{error: Function}} [opts.log]
 * @returns {{read: () => object, write: (state: object) => void, file: string}}
 */
function createJsonStore({ dir, name, fsImpl = nodeFs, now = Date.now, log = console }) {
  const file = nodePath.join(dir, name);

  /** How many times this document has been lost — one quarantine file each. */
  function quarantineCount() {
    try {
      return fsImpl.readdirSync(dir).filter((entry) => entry.startsWith(name + CORRUPT_SUFFIX)).length;
    } catch {
      return 0;
    }
  }

  function preserve() {
    const dest = `${file}${CORRUPT_SUFFIX}${stamp(now())}`;
    try {
      fsImpl.renameSync(file, dest);
      return dest;
    } catch {
      return null;
    }
  }

  function lost(reason) {
    const kept = preserve();
    log.error(
      `[gooni] ${name} was unreadable (${reason}) — buffered state lost; ` +
        (kept ? `the bytes are kept at ${kept}` : "the bytes could NOT be preserved")
    );
    // At least one, even when the quarantine rename failed: the loss happened
    // whether or not the evidence survived it.
    return { corrupted: Math.max(1, quarantineCount()) };
  }

  return {
    file,

    read() {
      let raw;
      try {
        raw = fsImpl.readFileSync(file, "utf8");
      } catch (e) {
        // No file yet is the normal first-launch path and says nothing.
        if (e && e.code === "ENOENT") return {};
        return lost(e?.message || "unreadable");
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not a JSON object");
        }
        return parsed;
      } catch (e) {
        return lost(e?.message || "unparseable");
      }
    },

    write(state) {
      const tmp = `${file}${TMP_SUFFIX}`;
      try {
        fsImpl.mkdirSync(dir, { recursive: true });
        fsImpl.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fsImpl.renameSync(tmp, file);
      } catch (e) {
        log.error(`[gooni] could not persist ${name}:`, e?.message || e);
        try {
          fsImpl.unlinkSync(tmp);
        } catch {
          /* nothing to clean up */
        }
      }
    },
  };
}

module.exports = { createJsonStore, CORRUPT_SUFFIX, TMP_SUFFIX };
