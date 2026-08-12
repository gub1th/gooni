const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { resolveToken, deriveToken } = require("../src/token");

test("derivation matches the backend's — sha256 hex of the password", () => {
  // app/common.py::_expected_token — hashlib.sha256(password).hexdigest()
  const expected = crypto.createHash("sha256").update("hunter2", "utf8").digest("hex");
  assert.equal(deriveToken("hunter2"), expected);
  assert.equal(deriveToken("hunter2").length, 64);
});

test("an explicit token wins over everything", () => {
  const r = resolveToken({ token: "abc", authPassword: "hunter2" }, "harvested-one");
  assert.deepEqual(r, { token: "abc", source: "config" });
});

test("a password is derived rather than round-tripped through /auth", () => {
  const r = resolveToken({ authPassword: "hunter2" }, "harvested-one");
  assert.equal(r.source, "password");
  assert.equal(r.token, deriveToken("hunter2"));
});

test("the normal path is the token harvested from the web app after signing in once", () => {
  assert.deepEqual(resolveToken({}, "harvested-one"), { token: "harvested-one", source: "harvested" });
});

test("nothing configured reports `none`, which the tray turns into a warning", () => {
  // The source is carried, not just the token: "not signed in" and "the token
  // you pasted is being rejected" need different advice.
  assert.deepEqual(resolveToken({}, ""), { token: "", source: "none" });
});
