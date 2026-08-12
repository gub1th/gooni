/**
 * A bounded, in-memory tail of a child process's output.
 *
 * The sidecar is a long-running Python daemon; over a day it will print far
 * more than anyone wants held in RAM, and the only question ever asked of it is
 * "what did it say just before it died". So: a ring of the last N lines, plus
 * an append-only file on disk for the times you need more than the tail.
 *
 * Chrome-free/electron-free on purpose — same testability split the extension
 * uses. Partial writes are stitched: a spawn's `data` events do not respect
 * line boundaries, and a supervisor that logged half-lines would corrupt the
 * one artifact you read after a crash.
 */

const DEFAULT_MAX_LINES = 500;

class LogBuffer {
  constructor({ maxLines = DEFAULT_MAX_LINES, onLine = null, now = Date.now } = {}) {
    this.maxLines = maxLines;
    this.onLine = onLine;
    this.now = now;
    this.lines = [];
    /** Lines evicted by the ring. Counted so the tail can admit it is a tail. */
    this.dropped = 0;
    this._partial = { stdout: "", stderr: "" };
  }

  /**
   * Feed a raw chunk from one stream. Returns the complete lines it produced.
   * A trailing fragment is held until the rest of it arrives (or `flush()`).
   */
  write(chunk, stream = "stdout") {
    const held = this._partial[stream] ?? "";
    const text = held + String(chunk);
    const parts = text.split(/\r?\n/);
    this._partial[stream] = parts.pop() ?? "";
    const emitted = [];
    for (const line of parts) {
      emitted.push(this._push(line, stream));
    }
    return emitted;
  }

  /** Emit whatever fragment is held — call on process exit, not before. */
  flush(stream = null) {
    const streams = stream ? [stream] : Object.keys(this._partial);
    const emitted = [];
    for (const s of streams) {
      const held = this._partial[s];
      if (held) {
        this._partial[s] = "";
        emitted.push(this._push(held, s));
      }
    }
    return emitted;
  }

  _push(text, stream) {
    const entry = { at: this.now(), stream, text };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) {
      this.dropped += this.lines.length - this.maxLines;
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    if (this.onLine) this.onLine(entry);
    return entry;
  }

  /** Newest-last, oldest-first — the order you read a log in. */
  tail(n = this.maxLines) {
    return this.lines.slice(Math.max(0, this.lines.length - n));
  }

  /**
   * The tail as text, prefixed with a note when the ring has evicted lines.
   * The note matters: a viewer showing 500 lines with no marker implies the
   * process only ever printed 500.
   */
  toText(n = this.maxLines) {
    const body = this.tail(n).map((l) => `${l.stream === "stderr" ? "! " : "  "}${l.text}`);
    if (this.dropped > 0) {
      body.unshift(`… ${this.dropped} earlier line(s) scrolled out of this buffer`);
    }
    return body.join("\n");
  }

  clear() {
    this.lines = [];
    this.dropped = 0;
    this._partial = { stdout: "", stderr: "" };
  }
}

module.exports = { LogBuffer, DEFAULT_MAX_LINES };
