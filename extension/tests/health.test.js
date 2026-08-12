import test from "node:test";
import assert from "node:assert/strict";

import { sensorHealth, STALE_BUFFER } from "../src/health.js";
import { DEFAULT_BASE_URL } from "../src/config.js";

const HEALTHY = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  hasToken: true,
  buffered: 0,
  dropped: 0,
  refused: 0,
  lastFlush: { at: "now", sent: 3, accepted: 3 },
};

test("the default backend is the DEPLOYED one — localhost only exists while dev.sh runs", () => {
  assert.equal(DEFAULT_BASE_URL, "https://gooni-bot.fly.dev");
});

test("healthy shows no badge — a permanent badge is one you stop reading", () => {
  const h = sensorHealth(HEALTHY);
  assert.equal(h.level, "ok");
  assert.equal(h.badge, "");
  assert.equal(h.message, null);
});

test("no token is an ERROR, even though it never writes a flush record", () => {
  // flushOnce returns not_configured with sent:0, and recordFlush deliberately
  // skips zero-sent flushes — so lastFlush stays null forever while the buffer
  // grows. Health has to come from config, not from the flush record.
  const h = sensorHealth({ ...HEALTHY, hasToken: false, buffered: 40, lastFlush: null });
  assert.equal(h.level, "error");
  assert.equal(h.badge, "!");
  assert.match(h.message, /40 interval/);
  assert.match(h.message, /nothing can be delivered/);
});

test("a rejected password is distinguished from no password", () => {
  const h = sensorHealth({ ...HEALTHY, buffered: 5, lastFlush: { error: "unauthorized" } });
  assert.equal(h.level, "error");
  assert.match(h.title, /rejected/);
  assert.match(h.message, /fix it in options/);
});

test("one failed send is a warning; a standing backlog behind it is an error", () => {
  const blip = sensorHealth({ ...HEALTHY, buffered: 2, lastFlush: { error: "http_404" } });
  assert.equal(blip.level, "warn");

  const outage = sensorHealth({
    ...HEALTHY,
    buffered: STALE_BUFFER,
    lastFlush: { error: "http_404" },
  });
  assert.equal(outage.level, "error");
  assert.match(outage.message, /nothing is listening/);
  assert.match(outage.message, /gooni-bot\.fly\.dev/, "name the host, since a wrong host IS the bug");
});

test("server-requested backpressure is not a failure", () => {
  // Gooni's own rate limiter. The buffer holds, the next alarm delivers.
  const h = sensorHealth({ ...HEALTHY, buffered: 60, lastFlush: { error: "retry_after" } });
  assert.equal(h.level, "ok");
});

test("a deliberate pause is reported as paused, not as broken", () => {
  const h = sensorHealth({ ...HEALTHY, enabled: false, buffered: 12 });
  assert.equal(h.level, "paused");
  assert.match(h.message, /12 interval/);
});

test("past loss stays visible after delivery recovers", () => {
  const h = sensorHealth({ ...HEALTHY, refused: 3, dropped: 7 });
  assert.equal(h.level, "warn");
  assert.match(h.message, /3 destroyed by the server/);
  assert.match(h.message, /7 lost to buffer overflow/);
});

test("a live outage outranks historical loss — one is fixable now", () => {
  const h = sensorHealth({ ...HEALTHY, hasToken: false, refused: 3, dropped: 7 });
  assert.equal(h.title, "Gooni sensor: not connected");
});

test("wire errors are translated, not printed raw", () => {
  const timeout = sensorHealth({ ...HEALTHY, buffered: 1, lastFlush: { error: "flush_timeout" } });
  assert.match(timeout.message, /accepted the connection then went quiet/);

  const server = sensorHealth({ ...HEALTHY, buffered: 1, lastFlush: { error: "http_503" } });
  assert.match(server.message, /server error/);

  const offline = sensorHealth({ ...HEALTHY, buffered: 1, lastFlush: { error: "TypeError: fetch failed" } });
  assert.match(offline.message, /couldn't reach Gooni/);
});

test("an empty status object does not throw", () => {
  const h = sensorHealth({});
  assert.equal(h.level, "error", "no token in an empty status is still no token");
});
