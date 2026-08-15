const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appearance = require("../src/appearance");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gooni-appearance-"));
}

test("the value arrives JSON-encoded from localStorage, quotes and all", () => {
  // LocalStorageService JSON-encodes every preference, so the raw string the
  // preload reads is `"dark"` WITH quotes. Stripping them at one place is the
  // whole reason this normaliser exists.
  assert.equal(appearance.normalizeTheme('"dark"'), "dark");
  assert.equal(appearance.normalizeTheme('"light"'), "light");
  // A hand-edited file with no quotes still works.
  assert.equal(appearance.normalizeTheme("dark"), "dark");
  assert.equal(appearance.normalizeTheme(" DARK "), "dark");
});

test("anything unrecognised is the frontend's own default, not a third state", () => {
  // useGooniThemeStore defaults to light; a shell that invented `null` or threw
  // would paint a window background no theme ever asks for.
  for (const junk of [undefined, null, "", "sepia", 7, {}, []]) {
    assert.equal(appearance.normalizeTheme(junk), "light");
  }
});

test("the void colours are the ones the app actually paints", () => {
  // Must match AMBIENT_PALETTES in frontend/src/stores/useGooniThemeStore.ts.
  // These two values are the ONLY thing on screen between the window appearing
  // and the page's first paint, so a drift here is a full-window flash.
  assert.equal(appearance.voidColor("dark"), "#000000");
  assert.equal(appearance.voidColor("light"), "#f7f6f2");
  assert.equal(appearance.voidColor('"dark"'), "#000000");
  assert.equal(appearance.voidColor("nonsense"), "#f7f6f2");
});

test("a first launch has nothing remembered and says so quietly", () => {
  const dir = tmp();
  // No file at all is the ordinary first-run state, not an error: it must not
  // throw, and it must land on the frontend's default.
  assert.equal(appearance.loadTheme(dir), "light");
  assert.equal(appearance.loadTheme(path.join(dir, "does-not-exist")), "light");
});

test("an unreadable file is 'no opinion yet', never a crash", () => {
  const dir = tmp();
  fs.writeFileSync(appearance.appearancePath(dir), "{ not json");
  assert.equal(appearance.loadTheme(dir), "light");
});

test("a harvested theme survives to the next launch", () => {
  const dir = tmp();
  appearance.saveTheme(dir, '"dark"');
  assert.equal(appearance.loadTheme(dir), "dark");
  // and it is stored normalised, so the file is readable by a human too
  assert.deepEqual(JSON.parse(fs.readFileSync(appearance.appearancePath(dir), "utf8")), { theme: "dark" });

  appearance.saveTheme(dir, "light");
  assert.equal(appearance.loadTheme(dir), "light");
});

test("it is a preference, not a credential — no 0600, and its own file", () => {
  const dir = tmp();
  appearance.saveTheme(dir, "dark");
  // token.json is 0600 because it holds a bearer token. This holds the word
  // "dark". Keeping them in separate files is also what stops a theme write
  // from ever being able to corrupt the token.
  const mode = fs.statSync(appearance.appearancePath(dir)).mode & 0o777;
  assert.notEqual(mode, 0o600);
  assert.equal(path.basename(appearance.appearancePath(dir)), "appearance.json");
});
