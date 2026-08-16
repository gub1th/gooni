const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectSidecar,
  resolveSidecarConfig,
  currentCameraIndex,
  withCameraIndex,
  DEFAULT_CAMERA_INDEX,
} = require("../src/sidecarDetect");

function fakeFs(existingPaths) {
  const set = new Set(existingPaths);
  return (p) => set.has(p);
}

test("detects the venv python at the known focus-cam path", () => {
  const home = "/Users/dani";
  const venv = "/Users/dani/Desktop/projects/focus-cam/.venv/bin/python";
  const detection = detectSidecar({ existsSync: fakeFs([venv]), homeDir: home });
  assert.ok(detection);
  assert.equal(detection.command, venv);
  assert.equal(detection.cwd, "/Users/dani/Desktop/projects/focus-cam", "cwd must be the project dir, not the venv");
  assert.deepEqual(detection.args, ["-u", "-m", "focus_cam.sidecar", "--camera", String(DEFAULT_CAMERA_INDEX)]);
});

test("returns null when nothing is found", () => {
  const detection = detectSidecar({ existsSync: fakeFs([]), homeDir: "/Users/dani" });
  assert.equal(detection, null);
});

test("returns null when injected fs/home are missing (no crash on a bad call)", () => {
  assert.equal(detectSidecar({}), null);
});

test("resolveSidecarConfig fills an empty command from detection", () => {
  const detection = { command: "/x/.venv/bin/python", args: ["-u"], cwd: "/x" };
  const { sidecar, autoDetected, detectedFrom } = resolveSidecarConfig(
    { enabled: true, command: "", args: [], cwd: "", env: {}, cameraIndex: null },
    detection
  );
  assert.equal(autoDetected, true);
  assert.equal(detectedFrom, "/x");
  assert.equal(sidecar.command, "/x/.venv/bin/python");
  assert.equal(sidecar.cwd, "/x");
  assert.deepEqual(sidecar.args, ["-u"]);
  assert.equal(sidecar.enabled, true, "fields outside command/args/cwd are carried through unchanged");
});

test("resolveSidecarConfig NEVER overwrites a manually-configured command", () => {
  const detection = { command: "/x/.venv/bin/python", args: ["-u"], cwd: "/x" };
  const manual = { enabled: true, command: "/manual/python3", args: ["main.py"], cwd: "/manual", env: {}, cameraIndex: null };
  const { sidecar, autoDetected } = resolveSidecarConfig(manual, detection);
  assert.equal(autoDetected, false);
  assert.deepEqual(sidecar, manual);
});

test("resolveSidecarConfig with no detection and no manual command stays unconfigured", () => {
  const { sidecar, autoDetected } = resolveSidecarConfig(
    { enabled: true, command: "", args: [], cwd: "", env: {}, cameraIndex: null },
    null
  );
  assert.equal(autoDetected, false);
  assert.equal(sidecar.command, "");
});

test("currentCameraIndex reads the --camera flag, falling back when absent", () => {
  assert.equal(currentCameraIndex(["-u", "-m", "x", "--camera", "1"]), 1);
  assert.equal(currentCameraIndex(["-u", "-m", "x"]), DEFAULT_CAMERA_INDEX);
  assert.equal(currentCameraIndex(["-u", "--camera"]), DEFAULT_CAMERA_INDEX, "a dangling flag with no value must not throw");
  assert.equal(currentCameraIndex(null), DEFAULT_CAMERA_INDEX);
});

test("withCameraIndex replaces an existing flag in place", () => {
  assert.deepEqual(withCameraIndex(["-u", "--camera", "1", "-x"], 2), ["-u", "--camera", "2", "-x"]);
});

test("withCameraIndex appends when the flag is absent", () => {
  assert.deepEqual(withCameraIndex(["-u", "-m", "x"], 0), ["-u", "-m", "x", "--camera", "0"]);
});

test("withCameraIndex does not mutate the input array", () => {
  const args = ["-u", "--camera", "1"];
  withCameraIndex(args, 9);
  assert.deepEqual(args, ["-u", "--camera", "1"]);
});
