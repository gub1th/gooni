/**
 * Test doubles: a controllable clock and a fake spawn.
 *
 * The supervisor's whole job is timing (backoff ladders, an uptime threshold, a
 * SIGTERM grace period) so real timers would make the tests both slow and
 * flaky. Everything time-shaped is injected, and these are what gets injected.
 */

const { EventEmitter } = require("node:events");

function makeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();

  return {
    now: () => now,
    setTimer(fn, delay) {
      const id = ++seq;
      timers.set(id, { fn, at: now + Number(delay || 0) });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Advance time, firing every timer whose deadline is crossed, in order. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.fn();
      }
      now = target;
    },
  };
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  exit(code = 0, signal = null) {
    this.emit("exit", code, signal);
  }
}

function makeSpawn() {
  let nextPid = 4000;
  const calls = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = new FakeChild(++nextPid);
    calls.push({ command, args, options });
    children.push(child);
    return child;
  };
  return {
    spawnImpl,
    calls,
    children,
    last: () => children[children.length - 1],
  };
}

function makeKills() {
  const signals = [];
  return {
    signals,
    killImpl: (pid, sig) => {
      signals.push({ pid, sig });
    },
  };
}

module.exports = { makeClock, makeSpawn, makeKills, FakeChild };
