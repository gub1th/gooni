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

  assert.equal(state.corrupted, 1, "a lost backlog is a third cause of loss, and it is counted");
  assert.equal(state.buffered, undefined);
  assert.match(errors.join(" "), /unreadable/);

  const kept = quarantined(dir);
  assert.equal(kept.length, 1, "the bytes are preserved alongside, not overwritten");
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), '{"buffered": [{"client_i');
});

test("the loss count survives the state file it was counted in", () => {
  let clock = T0;
  const { store, dir, file } = rig({ now: () => clock });

  fs.writeFileSync(file, "}}}");
  assert.equal(store.read().corrupted, 1);

  // The shell rewrites a fresh document; that one is fine.
  store.write({ buffered: [], corrupted: 1 });
  assert.equal(store.read().corrupted, 1, "a healthy read carries the persisted count forward");

  // ...and a SECOND corruption is counted off the quarantine files on disk,
  // which is the only record that outlives losing the counters themselves.
  clock = T0 + 60_000;
  fs.writeFileSync(file, "not json either");
  assert.equal(store.read().corrupted, 2);
  assert.equal(quarantined(dir).length, 2);
});

test("a file holding valid JSON that is not an object is treated as lost", () => {
  const { store, file } = rig();
  fs.writeFileSync(file, "[1,2,3]");
  assert.equal(store.read().corrupted, 1, "an array would silently answer every key with undefined");
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

  assert.equal(store.read().corrupted, 1, "the loss happened whether or not the evidence survived it");
  assert.match(errors.join(" "), /could NOT be preserved/);
});
