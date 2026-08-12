/**
 * Where the shell's Bearer token comes from.
 *
 * The backend derives its token as sha256(GOONI_AUTH_PASSWORD)
 * (app/common.py::_expected_token), and the web app stores the result in
 * localStorage under `gooni_token` after a successful `POST /auth`. So there
 * are three ways to have one, in descending order of explicitness:
 *
 *   1. `token` in config — you pasted it.
 *   2. `authPassword` in config — derive it, no round trip.
 *   3. harvested — the app window's preload reads localStorage after you sign
 *      in once, and the shell keeps it. This is the normal path: it means the
 *      capture hotkey works without ever asking for a second credential.
 *
 * Pure resolution here; the storage of (3) is at the bottom and is the only
 * part that touches fs.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN_FILENAME = "token.json";

function deriveToken(password) {
  return crypto.createHash("sha256").update(String(password), "utf8").digest("hex");
}

/**
 * @returns {{token: string, source: "config"|"password"|"harvested"|"none"}}
 * The source is carried, not just the token: "capture is not signed in" and
 * "capture is using a token you pasted that the server rejects" need different
 * advice, and the tray can only give it if it knows which it has.
 */
function resolveToken(config = {}, harvested = "") {
  if (config.token) return { token: config.token, source: "config" };
  if (config.authPassword) return { token: deriveToken(config.authPassword), source: "password" };
  if (harvested) return { token: harvested, source: "harvested" };
  return { token: "", source: "none" };
}

function tokenPath(userDataDir) {
  return path.join(userDataDir, TOKEN_FILENAME);
}

function loadHarvested(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenPath(userDataDir), "utf8"));
    return typeof raw?.token === "string" ? raw.token : "";
  } catch {
    return "";
  }
}

/** 0600 — it is a credential, not a preference. */
function saveHarvested(userDataDir, token) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    tokenPath(userDataDir),
    `${JSON.stringify({ token: String(token || "") }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

module.exports = { deriveToken, resolveToken, loadHarvested, saveHarvested, tokenPath, TOKEN_FILENAME };
