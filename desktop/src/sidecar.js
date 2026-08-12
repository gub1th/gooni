/**
 * The focus-cam sidecar supervisor — the reason this shell exists.
 *
 * The sidecar itself is NOT in this repo (see docs/focus_cam_contract.md): it's
 * a separately-built local macOS daemon that watches the webcam and reports to
 * Gooni over HTTP. Nothing has ever owned its lifetime — you started it in a
 * terminal, and when it died you found out because the widget's preview went
 * stale, if you happened to look. This gives it one owner: start it with the
 * app, restart it when it dies, keep its output, and stop it cleanly on quit.
 *
 * A shell does NOT reduce the number of moving parts — mediapipe keeps Python
 * alive regardless. What it buys is that the parts have a supervisor.
 *
 * Three rules shape the code, all of them the same rule this project keeps
 * relearning: a component that has stopped working must not look like one that
 * is working.
 *
 *  1. **Unconfigured is a STATE, not a default.** No command named => `unconfigured`,
 *     said out loud in the tray. It never degrades into a quiet "no sidecar today".
 *  2. **A crash loop is not "running".** Restarting is good; restarting every
 *     second forever is a broken sidecar wearing a healthy badge. Uptime past
 *     HEALTHY_UPTIME_MS resets the backoff; short lives escalate the delay and,
 *     past MAX_FAST_CRASHES, flip the state to `crashlooping` — still retrying
 *     (a transient cause deserves recovery) but no longer claiming health.
 *  3. **Stop means stopped.** SIGTERM, then SIGKILL after a grace period, to the
 *     process GROUP — Python daemons spawn helpers, and a supervisor that leaves
 *     a camera-holding orphan behind after quit is worse than no supervisor,
 *     because the privacy light stays on with nothing owning it.
 *
 * `spawnImpl`, timers and clock are injected so all of that is testable without
 * launching real processes.
 */

const { LogBuffer } = require("./logbuffer");

/** How long a run must last before we call it healthy and reset the backoff. */
const HEALTHY_UPTIME_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** Consecutive sub-HEALTHY runs before we stop calling it a hiccup. */
const MAX_FAST_CRASHES = 5;
/** Grace between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 5_000;

const STATES = Object.freeze({
  DISABLED: "disabled",
  UNCONFIGURED: "unconfigured",
  STARTING: "starting",
  RUNNING: "running",
  BACKOFF: "backoff",
  CRASHLOOPING: "crashlooping",
  STOPPED: "stopped",
  FAILED: "failed",
});

/** Exponential, capped. Pure so the ladder is asserted rather than eyeballed. */
function backoffDelay(consecutiveFailures, { base = BASE_BACKOFF_MS, max = MAX_BACKOFF_MS } = {}) {
  const n = Math.max(0, consecutiveFailures - 1);
  return Math.min(base * 2 ** n, max);
}

/** One line of human text for a state — the tray's whole vocabulary. */
function describe(status) {
  switch (status.state) {
    case STATES.DISABLED:
      return "Sidecar: off (disabled in config)";
    case STATES.UNCONFIGURED:
      return "Sidecar: NOT CONFIGURED — set sidecar.command";
    case STATES.STARTING:
      return "Sidecar: starting…";
    case STATES.RUNNING:
      return `Sidecar: running (pid ${status.pid})`;
    case STATES.BACKOFF:
      return `Sidecar: died, retrying in ${Math.round((status.retryInMs ?? 0) / 1000)}s`;
    case STATES.CRASHLOOPING:
      return `Sidecar: CRASH LOOPING (${status.consecutiveFailures} fast exits) — check the log`;
    case STATES.STOPPED:
      return "Sidecar: stopped";
    case STATES.FAILED:
      return `Sidecar: FAILED — ${status.lastError || "unknown error"}`;
    default:
      return `Sidecar: ${status.state}`;
  }
}

/** States where the sidecar is not sensing and a human needs to know. */
function isUnhealthy(state) {
  return (
    state === STATES.UNCONFIGURED || state === STATES.FAILED || state === STATES.CRASHLOOPING
  );
}

class SidecarSupervisor {
  /**
   * @param {object} opts
   * @param {Function} opts.spawnImpl        child_process.spawn-compatible
   * @param {Function} [opts.canExecute]     (cmd) => boolean; preflight so a
   *   typo'd path FAILS with the path in the message instead of producing an
   *   ENOENT crash loop that reads like a broken sidecar.
   * @param {Function} [opts.onEvent]        (status) => void, on every transition
   * @param {Function} [opts.onLine]         ({at,stream,text}) => void
   * @param {Function} [opts.killImpl]       (pid, signal) => void
   */
  constructor({
    spawnImpl,
    canExecute = () => true,
    onEvent = () => {},
    onLine = null,
    killImpl = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    healthyUptimeMs = HEALTHY_UPTIME_MS,
    stopGraceMs = STOP_GRACE_MS,
    maxFastCrashes = MAX_FAST_CRASHES,
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.canExecute = canExecute;
    this.onEvent = onEvent;
    this.killImpl = killImpl || ((pid, signal) => process.kill(pid, signal));
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.healthyUptimeMs = healthyUptimeMs;
    this.stopGraceMs = stopGraceMs;
    this.maxFastCrashes = maxFastCrashes;

    this.log = new LogBuffer({ onLine });
    this.config = null;
    this.child = null;
    this.state = STATES.STOPPED;
    this.startedAt = null;
    this.consecutiveFailures = 0;
    this.restarts = 0;
    this.lastExit = null;
    this.lastError = null;
    this.retryTimer = null;
    this.retryAt = null;
    this._stopping = null;
    this._killTimer = null;
  }

  status() {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? this.now() - this.startedAt : null,
      restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures,
      lastExit: this.lastExit,
      lastError: this.lastError,
      retryInMs: this.retryAt ? Math.max(0, this.retryAt - this.now()) : null,
      command: this.config?.command || "",
      logDropped: this.log.dropped,
    };
  }

  _set(state, { error = undefined } = {}) {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.onEvent(this.status());
  }

  _note(text) {
    // Supervisor commentary shares the log with the child's own output, marked
    // so it is never mistaken for something the sidecar printed.
    this.log.write(`[shell] ${text}\n`, "stdout");
  }

  /**
   * Apply config. Returns the resulting state. Safe to call repeatedly — the
   * tray toggles route through here.
   */
  configure(sidecarConfig) {
    this.config = sidecarConfig || null;
    return this.state;
  }

  /**
   * Bring the sidecar up. Idempotent: calling it while running is a no-op, so
   * a config reload can't accidentally fork a second camera owner.
   */
  start() {
    if (this.child) return this.status();
    this._clearRetry();

    const cfg = this.config;
    if (!cfg || cfg.enabled === false) {
      this._set(STATES.DISABLED, { error: null });
      return this.status();
    }
    if (!cfg.command) {
      // Loud on purpose. This is the state a fresh install sits in, and the one
      // most likely to be mistaken for "supervised, nothing to do".
      this._set(STATES.UNCONFIGURED, { error: null });
      return this.status();
    }
    if (!this.canExecute(cfg.command)) {
      this._set(STATES.FAILED, { error: `command not found or not executable: ${cfg.command}` });
      return this.status();
    }

    this._set(STATES.STARTING, { error: null });
    let child;
    try {
      child = this.spawnImpl(cfg.command, cfg.args || [], {
        cwd: cfg.cwd || undefined,
        env: { ...process.env, ...(cfg.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so stop() can take the whole tree down. A
        // Python daemon that forks helpers would otherwise leave them holding
        // the camera after the app quits.
        detached: true,
      });
    } catch (e) {
      this._set(STATES.FAILED, { error: `spawn failed: ${e.message}` });
      return this.status();
    }

    this.child = child;
    this.startedAt = this.now();
    this._note(`started: ${cfg.command} ${(cfg.args || []).join(" ")}`.trim());

    child.stdout?.on("data", (d) => this.log.write(d, "stdout"));
    child.stderr?.on("data", (d) => this.log.write(d, "stderr"));
    child.on("error", (e) => {
      // Post-spawn failures (ENOENT surfaces here on some platforms). Recorded
      // rather than thrown: the exit handler decides whether to retry.
      this.lastError = `process error: ${e.message}`;
      this._note(this.lastError);
    });
    child.on("exit", (code, signal) => this._onExit(code, signal));

    this._set(STATES.RUNNING, { error: null });
    return this.status();
  }

  _onExit(code, signal) {
    const ranFor = this.startedAt ? this.now() - this.startedAt : 0;
    this.log.flush();
    this.child = null;
    this.startedAt = null;
    this.lastExit = { code, signal, at: this.now(), ranForMs: ranFor };
    if (this._killTimer !== null) {
      this.clearTimer(this._killTimer);
      this._killTimer = null;
    }

    if (this._stopping) {
      // We asked for this. Not a failure, and the backoff ladder must not
      // remember it — a deliberate stop/start cycle should come back instantly.
      this._note(`stopped (code ${code}, signal ${signal})`);
      this.consecutiveFailures = 0;
      const resolve = this._stopping;
      this._stopping = null;
      this._set(STATES.STOPPED);
      resolve(this.status());
      return;
    }

    this._note(`exited unexpectedly after ${Math.round(ranFor / 1000)}s (code ${code}, signal ${signal})`);
    if (ranFor >= this.healthyUptimeMs) {
      // It held up for a while, so this is one death rather than a loop.
      this.consecutiveFailures = 1;
    } else {
      this.consecutiveFailures += 1;
    }
    this._scheduleRestart();
  }

  _scheduleRestart() {
    const delay = backoffDelay(this.consecutiveFailures);
    this.retryAt = this.now() + delay;
    // Keep retrying past the threshold — the cause may be transient (an unplugged
    // camera, a machine that just woke) — but stop calling it healthy.
    const looping = this.consecutiveFailures >= this.maxFastCrashes;
    this._set(looping ? STATES.CRASHLOOPING : STATES.BACKOFF);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.retryAt = null;
      this.restarts += 1;
      this.start();
    }, delay);
  }

  _clearRetry() {
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAt = null;
  }

  /**
   * Signal the whole process group, falling back to the bare pid.
   *
   * The group kill is the point (see the class header), but a child that
   * already exited, or a platform that refuses the negative pid, must not throw
   * out of a quit handler — a supervisor that crashes while shutting down is
   * how orphans are made.
   */
  _signal(pid, sig) {
    try {
      this.killImpl(-pid, sig);
      return true;
    } catch {
      try {
        this.killImpl(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Stop and WAIT. Resolves once the child is actually gone (or was never
   * there). `before-quit` awaits this, which is the only thing standing between
   * a quit and a camera-holding orphan.
   */
  stop() {
    this._clearRetry();
    if (!this.child) {
      if (this.state !== STATES.DISABLED && this.state !== STATES.UNCONFIGURED) {
        this._set(STATES.STOPPED);
      }
      return Promise.resolve(this.status());
    }
    if (this._stopping) return this._stoppingPromise;

    const pid = this.child.pid;
    this._stoppingPromise = new Promise((resolve) => {
      this._stopping = resolve;
    });
    this._note("stopping (SIGTERM)");
    this._signal(pid, "SIGTERM");
    this._killTimer = this.setTimer(() => {
      this._killTimer = null;
      if (this._stopping) {
        this._note("did not exit in time — SIGKILL");
        this._signal(pid, "SIGKILL");
      }
    }, this.stopGraceMs);
    return this._stoppingPromise;
  }

  async restart() {
    await this.stop();
    this.consecutiveFailures = 0;
    return this.start();
  }
}

module.exports = {
  SidecarSupervisor,
  STATES,
  backoffDelay,
  describe,
  isUnhealthy,
  HEALTHY_UPTIME_MS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_FAST_CRASHES,
  STOP_GRACE_MS,
};
