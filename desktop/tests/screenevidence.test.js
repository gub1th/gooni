const test = require("node:test");
const assert = require("node:assert/strict");

const { toEvidence } = require("../src/screenpipe");
const { SessionWatcher, ingestSession } = require("../src/screenevidence");

// ── screenpipe.toEvidence ────────────────────────────────────────────────────

test("toEvidence mints a stable dedup id and blanks empty strings to null", () => {
  const rows = [
    { id: 5, timestamp: "2026-09-09T05:00:00Z", app_name: "cmux", window_name: "w", browser_url: "", text: "hi", snapshot_path: "/x/5.jpg" },
    { id: 6, timestamp: "2026-09-09T05:00:01Z", app_name: "  ", window_name: null, browser_url: "https://x.com", text: "", snapshot_path: null },
  ];
  const out = toEvidence(42, rows);
  assert.equal(out[0].client_id, "sp-42-5", "id is session + screenpipe frame id (dedups on replay)");
  assert.equal(out[0].url, null, "empty string → null, not ''");
  assert.equal(out[0].imagePath, "/x/5.jpg");
  assert.equal(out[1].app, null, "whitespace-only app → null");
  assert.equal(out[1].text, null);
  assert.equal(out[1].imagePath, null);
});

test("toEvidence drops rows with no id or no timestamp, keeps text-less ones", () => {
  const out = toEvidence(1, [
    { id: null, timestamp: "2026-09-09T05:00:00Z", app_name: "x" },
    { id: 9, timestamp: null, app_name: "x" },
    { id: 10, timestamp: "2026-09-09T05:00:00Z", app_name: "Finder", text: null, snapshot_path: null },
  ]);
  assert.equal(out.length, 1, "only the row with id AND ts survives");
  assert.equal(out[0].app, "Finder", "a text-less frame is still kept — it places a moment");
});

// ── SessionWatcher ───────────────────────────────────────────────────────────

function makeWatcher(overrides = {}) {
  const stops = [];
  const w = new SessionWatcher({
    getActive: overrides.getActive || (async () => null),
    getSession: overrides.getSession || (async (id) => ({ id, state: "stopped", started_at: "s", ended_at: "e" })),
    onStop: async (s) => stops.push(s),
    log: () => {},
  });
  return { w, stops };
}

test("a session going active → null fires onStop for the one that ended", async () => {
  let active = { id: 7 };
  const { w, stops } = makeWatcher({ getActive: async () => active });
  await w.tick();                       // sees 7 active
  assert.equal(stops.length, 0, "no stop yet");
  active = null;                        // 7 stopped
  await w.tick();
  assert.equal(stops.length, 1, "the stop fired");
  assert.equal(stops[0].id, 7);
});

test("active A → active B is also a stop of A (switch ends the old session)", async () => {
  let active = { id: 7 };
  const { w, stops } = makeWatcher({ getActive: async () => active });
  await w.tick();
  active = { id: 8 };                    // started 8, which ended 7
  await w.tick();
  assert.deepEqual(stops.map((s) => s.id), [7], "A's stop fired when B took over");
});

test("a stopped session that is NOT actually stopped server-side is ignored", async () => {
  // Defensive: getSession says it's still paused. Don't summarize a live session.
  let active = { id: 7 };
  const { w, stops } = makeWatcher({
    getActive: async () => active,
    getSession: async (id) => ({ id, state: "paused", started_at: "s", ended_at: null }),
  });
  await w.tick();
  active = null;
  await w.tick();
  assert.equal(stops.length, 0, "a paused session is not a stop");
});

test("a getActive failure is not read as a stop", async () => {
  let mode = "up";
  const { w, stops } = makeWatcher({
    getActive: async () => {
      if (mode === "down") throw new Error("offline");
      return { id: 7 };
    },
  });
  await w.tick();                       // 7 active
  mode = "down";
  await w.tick();                       // backend blip
  assert.equal(stops.length, 0, "a failed poll must not fabricate a session end");
  assert.equal(w.lastActiveId, 7, "and it remembers 7 was active");
});

test("tick does not overlap itself while a slow ingest runs", async () => {
  let active = { id: 7 };
  let inStop = 0;
  let maxConcurrent = 0;
  const w = new SessionWatcher({
    getActive: async () => active,
    getSession: async (id) => ({ id, state: "stopped", started_at: "s", ended_at: "e" }),
    onStop: async () => {
      inStop++;
      maxConcurrent = Math.max(maxConcurrent, inStop);
      await new Promise((r) => setTimeout(r, 20));
      inStop--;
    },
  });
  await w.tick();
  active = null;
  const a = w.tick();
  const b = w.tick(); // fires while a is mid-ingest — must no-op
  await Promise.all([a, b]);
  assert.equal(maxConcurrent, 1, "the guard kept the two ticks from overlapping");
});

// ── ingestSession ────────────────────────────────────────────────────────────

function fakeApi() {
  const posted = [];
  const uploads = [];
  return {
    posted,
    uploads,
    postScreenEvidence: async (sid, frames, opts) => posted.push({ sid, frames, final: opts.final }),
    uploadScreenFrame: async (sid, cid) => uploads.push({ sid, cid }),
  };
}

// A fake sqlite3 execFile that returns two frames as -json.
function fakeSqlite(rows) {
  return (_bin, _args, _opts, cb) => cb(null, JSON.stringify(rows), "");
}

const SESSION = { id: 3, started_at: "2026-09-09T05:00:00Z", ended_at: "2026-09-09T05:40:00Z" };

test("ingestSession posts the window and marks the LAST batch final", async () => {
  const api = fakeApi();
  const rows = [
    { id: 1, timestamp: "2026-09-09T05:01:00Z", app_name: "cmux", text: "a", snapshot_path: "/1.jpg" },
    { id: 2, timestamp: "2026-09-09T05:02:00Z", app_name: "Chrome", text: "b", snapshot_path: null },
  ];
  const r = await ingestSession({
    session: SESSION,
    api,
    dbPath: "/live.db",
    copyFile: () => {},
    readFile: () => Buffer.from(""),
    exists: () => true,
    tmpPath: "/tmp/copy.db",
    execFileImpl: fakeSqlite(rows),
  });
  assert.equal(r.frames, 2);
  assert.equal(api.posted.length, 1);
  assert.equal(api.posted[0].final, true, "the only batch is final → triggers the summary");
  assert.ok(!("imagePath" in api.posted[0].frames[0]), "the local jpg path is NEVER sent to the cloud");
});

test("ingestSession skips cleanly when Screenpipe isn't installed", async () => {
  const api = fakeApi();
  const r = await ingestSession({
    session: SESSION, api, dbPath: "/live.db",
    copyFile: () => { throw new Error("should not copy"); },
    readFile: () => Buffer.from(""), exists: () => false, tmpPath: "/t", execFileImpl: fakeSqlite([]),
  });
  assert.deepEqual(r, { frames: 0, uploaded: 0 });
  assert.equal(api.posted.length, 0, "no DB → no post, no throw");
});

test("ingestSession does not fire `final` on a partial window when a batch fails", async () => {
  const api = fakeApi();
  api.postScreenEvidence = async () => { throw new Error("500"); };
  const r = await ingestSession({
    session: SESSION, api, dbPath: "/live.db",
    copyFile: () => {}, readFile: () => Buffer.from(""), exists: () => true,
    tmpPath: "/t", execFileImpl: fakeSqlite([{ id: 1, timestamp: "2026-09-09T05:01:00Z", app_name: "x" }]),
  });
  assert.equal(r.uploaded, 0, "a failed post stops before Phase 2");
});

test("ingestSession Phase 2 uploads only frames that have a readable image", async () => {
  const api = fakeApi();
  const rows = [
    { id: 1, timestamp: "2026-09-09T05:01:00Z", app_name: "cmux", text: "a", snapshot_path: "/1.jpg" },
    { id: 2, timestamp: "2026-09-09T05:02:00Z", app_name: "Chrome", text: "b", snapshot_path: null },       // no image
    { id: 3, timestamp: "2026-09-09T05:03:00Z", app_name: "Notes", text: "c", snapshot_path: "/gone.jpg" }, // missing file
  ];
  const r = await ingestSession({
    session: SESSION, api, dbPath: "/live.db",
    copyFile: () => {}, readFile: () => Buffer.from("jpeg"),
    exists: (p) => p === "/live.db" || p === "/1.jpg",   // only /1.jpg exists
    tmpPath: "/t", execFileImpl: fakeSqlite(rows), uploadFrames: true,
  });
  assert.equal(r.frames, 3);
  assert.equal(r.uploaded, 1, "only the frame with an existing file uploaded");
  assert.equal(api.uploads[0].cid, "sp-3-1");
});

test("ingestSession: a single frame's upload failure doesn't sink the rest", async () => {
  const api = fakeApi();
  let n = 0;
  api.uploadScreenFrame = async (sid, cid) => { n++; if (n === 1) throw new Error("R2 down"); api.uploads.push({ cid }); };
  const rows = [
    { id: 1, timestamp: "2026-09-09T05:01:00Z", app_name: "a", text: "a", snapshot_path: "/1.jpg" },
    { id: 2, timestamp: "2026-09-09T05:02:00Z", app_name: "b", text: "b", snapshot_path: "/2.jpg" },
  ];
  const r = await ingestSession({
    session: SESSION, api, dbPath: "/live.db",
    copyFile: () => {}, readFile: () => Buffer.from("x"), exists: () => true,
    tmpPath: "/t", execFileImpl: fakeSqlite(rows), uploadFrames: true,
  });
  assert.equal(r.uploaded, 1, "one failed upload, the other still went");
});
