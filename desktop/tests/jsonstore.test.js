/**
 * The shell's durable JSON document.
 *
 * What carries weight here is what happens when a write or a file goes wrong:
 * the thing persisted is buffered attention plus the counters that admit
 * losing it, so a half-written file that reads as empty is the worst outcome
 * available. Real files in a temp dir, with fs faults injected where a crash
 * would otherwise be needed.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createJsonStore, CORRUPT_SUFFIX } = require("../src/jsonstore");
const { AppReporter, describeReporter } = require("../src/appreporter");

const T0 = 1_700_000_000_000;

function rig({ fsImpl = fs, now = () => T0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gooni-store-"));
  const errors = [];
  const store = createJsonStore({
    dir,
    name: "app-sensor.json",
    fsImpl,
    now,
    log: { error: (...args) => errors.push(args.join(" ")) },
  });
  return { dir, store, errors, file: path.join(dir, "app-sensor.json") };
}

const quarantined = (dir) => fs.readdirSync(dir).filter((f) => f.includes(CORRUPT_SUFFIX));

test("a round trip returns what was written", () => {
  const { store } = rig();
  store.write({ buffered: [{ client_id: "a" }], dropped: 2 });
  assert.deepEqual(store.read(), { buffered: [{ client_id: "a" }], dropped: 2 });
});

test("no file yet is the quiet normal path", () => {
  const { store, errors, dir } = rig();
  assert.deepEqual(store.read(), {}, "every first launch reads nothing");
  assert.deepEqual(errors, [], "a missing file is not a problem to announce");
  assert.deepEqual(quarantined(dir), []);
});

test("a write leaves no temp file behind", () => {
  const { store, dir } = rig();
  store.write({ buffered: [] });
  assert.deepEqual(fs.readdirSync(dir), ["app-sensor.json"]);
});

test("a write that dies midway leaves the PREVIOUS document intact", () => {
  // The crash this exists for: an in-place writeFileSync truncates the target
  // and the next launch reads an empty backlog as a clean first run.
  let fail = false;
  const flaky = {
    ...fs,
    writeFileSync(target, data, opts) {
      if (!fail) return fs.writeFileSync(target, data, opts);
      fs.writeFileSync(target, String(data).slice(0, 8), opts);
      throw new Error("ENOSPC");
    },
  };
  const { store, errors, dir } = rig({ fsImpl: flaky });

  store.write({ buffered: [{ client_id: "a" }], dropped: 3, refused: 1 });
  fail = true;
  store.write({ buffered: [{ client_id: "b" }], dropped: 9, refused: 4 });

  assert.deepEqual(
    store.read(),
    { buffered: [{ client_id: "a" }], dropped: 3, refused: 1 },
    "either the whole old document or the whole new one — never a truncated one"
  );
  assert.equal(quarantined(dir).length, 0, "nothing was corrupted, so nothing to quarantine");
  assert.match(errors.join(" "), /could not persist/);
});

test("an unreadable file is loud, preserved, and counted — not a clean first launch", () => {
  const { store, errors, dir, file } = rig();
  fs.writeFileSync(file, '{"buffered": [{"client_i');

  const state = store.read();

  assert.deepEqual(state, {}, "the state is gone; nothing about it is recoverable");
  assert.equal(store.losses(), 1, "a lost backlog is a third cause of loss, and it is counted");
  assert.match(errors.join(" "), /unreadable/);

  const kept = quarantined(dir);
  assert.equal(kept.length, 1, "the bytes are preserved alongside, not overwritten");
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), '{"buffered": [{"client_i');
});

test("the loss count survives the state file it was counted in", () => {
  let clock = T0;
  const { store, dir, file } = rig({ now: () => clock });

  fs.writeFileSync(file, "}}}");
  store.read();
  assert.equal(store.losses(), 1);

  // The shell rewrites a fresh document; that one is fine, and it carries no
  // count of its own — the quarantine files are the record.
  store.write({ buffered: [] });
  assert.equal(store.losses(), 1, "a healthy read does not forget the earlier loss");

  clock = T0 + 60_000;
  fs.writeFileSync(file, "not json either");
  store.read();
  assert.equal(store.losses(), 2);
  assert.equal(quarantined(dir).length, 2);
});

test("a file holding valid JSON that is not an object is treated as lost", () => {
  const { store, file } = rig();
  fs.writeFileSync(file, "[1,2,3]");
  assert.deepEqual(store.read(), {}, "an array would silently answer every key with undefined");
  assert.equal(store.losses(), 1);
});

test("the loss is still counted when the bytes cannot be preserved", () => {
  const readOnly = {
    ...fs,
    renameSync(from, to) {
      if (String(to).includes(CORRUPT_SUFFIX)) throw new Error("EPERM");
      return fs.renameSync(from, to);
    },
  };
  const { store, errors, file } = rig({ fsImpl: readOnly });
  fs.writeFileSync(file, "{oops");

  store.read();
  assert.equal(store.losses(), 1, "the loss happened whether or not the evidence survived it");
  assert.match(errors.join(" "), /could NOT be preserved/);
});

// ── the number the tray prints ───────────────────────────────────────────────

/**
 * The reporter over the REAL two-file layout, across simulated launches. The
 * invariant: the tray's count equals the number of documents actually lost, no
 * matter which of the two files was involved or how many times each was.
 */
test("state-loss count equals the real losses across both files and many launches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gooni-store-"));
  let clock = T0;
  const errors = [];
  const log = { error: (...args) => errors.push(args.join(" ")) };
  const paths = {
    main: path.join(dir, "app-sensor.json"),
    open: path.join(dir, "app-sensor-open.json"),
  };

  const launch = () =>
    new AppReporter({
      store: createJsonStore({ dir, name: "app-sensor.json", now: () => clock, log }),
      openStore: createJsonStore({ dir, name: "app-sensor-open.json", now: () => clock, log }),
      getBaseUrl: () => "https://gooni-bot.fly.dev",
      getToken: () => "tok",
      now: () => clock,
    });
  const corrupt = (which) => {
    clock += 60_000;
    fs.writeFileSync(paths[which], "{truncated mid-writ");
  };

  let reporter = launch();
  assert.equal(reporter.corrupted, 0, "a first launch has lost nothing");
  reporter.add({ client_id: "a", app: "cursor", started_at: "x", ended_at: "y" });
  reporter.setOpen({ app: "cursor", startedAt: T0, lastSeenAt: T0 });

  corrupt("open");
  reporter = launch();
  assert.equal(reporter.corrupted, 1);
  // Sensing continues, which persists the MAIN document while the open store's
  // loss is already on the books.
  reporter.add({ client_id: "b", app: "cursor", started_at: "x", ended_at: "y" });

  corrupt("open");
  reporter = launch();
  assert.equal(reporter.corrupted, 2, "two losses, not three — a derived count is never added to itself");

  corrupt("main");
  reporter = launch();
  assert.equal(reporter.corrupted, 3, "and the open store's history is not discarded with the main file");
  assert.equal(reporter.dropped, 0, "a lost file is not a buffer overflow");
  assert.equal(reporter.refused, 0, "and it is not a server refusal either");
  assert.equal(reporter.status().corrupted, 3);
  assert.match(describeReporter(reporter.status(), { enabled: true, permission: true }), /state lost 3×/);

  assert.equal(
    fs.readdirSync(dir).filter((f) => f.includes(CORRUPT_SUFFIX)).length,
    3,
    "three documents were really lost"
  );
});
