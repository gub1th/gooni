/**
 * Camera enumeration for the tray's picker.
 *
 * `python -m focus_cam --list-cameras` is the sidecar's own inventory command
 * (see the launch brief) — the shell does not probe the OS for cameras itself,
 * it asks the same interpreter that will open one, so the list it shows is the
 * list the sidecar can actually use.
 *
 * The parser is pure and forgiving on purpose: the sidecar isn't in this repo,
 * so its exact output format isn't pinned here. It accepts a JSON array
 * (`[{"index":0,"name":"…"}]` or `["FaceTime HD Camera", …]`) or plain text,
 * one camera per line (`0: FaceTime HD Camera`, `0 - Continuity Camera`, or a
 * bare name with the line number as the index). Anything it can't parse a
 * camera out of is a warning, not a crash — a picker with zero entries plus a
 * "detect cameras" retry is a better failure than one that throws.
 */

/** `"0: FaceTime HD Camera"` / `"0 - Continuity Camera"` / `"0) Camera"` */
const LINE_RE = /^\s*(\d+)\s*[:\-)]\s*(.+?)\s*$/;

function parseCameraList(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];

  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json
        .map((entry, i) => {
          if (entry && typeof entry === "object") {
            const index = Number.isInteger(entry.index) ? entry.index : i;
            const name = String(entry.name ?? entry.label ?? `Camera ${index}`);
            return { index, name };
          }
          return { index: i, name: String(entry) };
        })
        .filter((c) => Number.isInteger(c.index));
    }
  } catch {
    // Not JSON — fall through to line parsing.
  }

  const cameras = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const m = line.match(LINE_RE);
    if (m) cameras.push({ index: Number(m[1]), name: m[2] });
    else cameras.push({ index: i, name: line });
  });
  return cameras;
}

/**
 * Run the sidecar's list-cameras command and parse it. `execFileImpl` is
 * `child_process.execFile`-compatible and injected so this is testable
 * without spawning a real interpreter.
 */
function listCameras({ execFileImpl, command, cwd, env, args = ["-m", "focus_cam", "--list-cameras"] }) {
  return new Promise((resolve, reject) => {
    if (!command) {
      reject(new Error("no sidecar command configured"));
      return;
    }
    execFileImpl(command, args, { cwd: cwd || undefined, env, timeout: 10_000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(parseCameraList(stdout));
    });
  });
}

module.exports = { parseCameraList, listCameras };
