const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCameraList, listCameras } = require("../src/cameraList");

test("parses a JSON array of objects", () => {
  const out = parseCameraList('[{"index":0,"name":"Continuity Camera"},{"index":1,"name":"FaceTime HD Camera"}]');
  assert.deepEqual(out, [
    { index: 0, name: "Continuity Camera" },
    { index: 1, name: "FaceTime HD Camera" },
  ]);
});

test("parses a JSON array of bare strings, indexed by position", () => {
  const out = parseCameraList('["Continuity Camera", "FaceTime HD Camera"]');
  assert.deepEqual(out, [
    { index: 0, name: "Continuity Camera" },
    { index: 1, name: "FaceTime HD Camera" },
  ]);
});

test("parses plain-text lines with colon, dash, or paren separators", () => {
  const out = parseCameraList("0: Continuity Camera\n1 - FaceTime HD Camera\n2) USB Webcam\n");
  assert.deepEqual(out, [
    { index: 0, name: "Continuity Camera" },
    { index: 1, name: "FaceTime HD Camera" },
    { index: 2, name: "USB Webcam" },
  ]);
});

test("falls back to line position when a line has no recognizable index", () => {
  const out = parseCameraList("Continuity Camera\nFaceTime HD Camera");
  assert.deepEqual(out, [
    { index: 0, name: "Continuity Camera" },
    { index: 1, name: "FaceTime HD Camera" },
  ]);
});

test("empty output is an empty list, not an error", () => {
  assert.deepEqual(parseCameraList(""), []);
  assert.deepEqual(parseCameraList(null), []);
  assert.deepEqual(parseCameraList("   \n  "), []);
});

test("listCameras rejects with no command configured", async () => {
  await assert.rejects(() => listCameras({ execFileImpl: () => {}, command: "" }));
});

test("listCameras resolves the parsed list on success", async () => {
  const execFileImpl = (command, args, opts, cb) => cb(null, "0: FaceTime HD Camera\n");
  const out = await listCameras({ execFileImpl, command: "/x/python", cwd: "/x" });
  assert.deepEqual(out, [{ index: 0, name: "FaceTime HD Camera" }]);
});

test("listCameras rejects when the process errors", async () => {
  const execFileImpl = (command, args, opts, cb) => cb(new Error("not found"));
  await assert.rejects(() => listCameras({ execFileImpl, command: "/x/python" }), /not found/);
});
