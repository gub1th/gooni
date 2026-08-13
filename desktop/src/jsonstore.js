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
 *    (`<name>.corrupt-<stamp>`) rather than overwritten, logged, and COUNTED.
 *    That count is a THIRD cause of loss, distinct from the reporter's
 *    `dropped` (buffer overflow) and `refused` (the server refused the batch),
 *    and it is reported separately because the tray labels those two
 *    specifically.
 *
 *    `losses()` DERIVES the number from the quarantine files that exist, and
 *    that is the whole design: a running total has to be written by somebody,
 *    and the document it would live in is the one corruption destroys — two
 *    writers with different notions of the total is how a number that exists to
 *    admit a loss becomes a lie about it. The quarantine files outlive every
 *    state file, so counting them answers "how many times was this document
 *    lost" with no accumulator to disagree with.
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
 * @returns {{read: () => object, write: (state: object) => void, losses: () => number, file: string}}
 */
function createJsonStore({ dir, name, fsImpl = nodeFs, now = Date.now, log = console }) {
  const file = nodePath.join(dir, name);
  // Losses whose bytes could NOT be preserved, so no quarantine file records
  // them. In memory only: the unreadable document is still sitting there and
  // the next read counts it again.
  let unpreserved = 0;

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
    if (!kept) unpreserved += 1;
    log.error(
      `[gooni] ${name} was unreadable (${reason}) — buffered state lost; ` +
        (kept ? `the bytes are kept at ${kept}` : "the bytes could NOT be preserved")
    );
    // The state itself is gone; nothing about it is recoverable, and the loss is
    // counted by `losses()` rather than smuggled back in as state.
    return {};
  }

  return {
    file,

    /**
     * How many times this document has been lost, derived from what is on disk.
     * The loss happened whether or not the evidence survived it, so a failed
     * quarantine still counts.
     */
    losses() {
      return quarantineCount() + unpreserved;
    },

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
