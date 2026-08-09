/**
 * Privacy net: full URLs are kept, credentials are not.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { scrubUrl, isSecretParam } from "../src/scrub.js";

test("the LeetCode problem slug survives — it is the task identity", () => {
  const r = scrubUrl("https://leetcode.com/problems/minimum-genetic-mutation/");
  assert.equal(r.host, "leetcode.com");
  assert.equal(r.path, "/problems/minimum-genetic-mutation/");
  assert.equal(r.url, "https://leetcode.com/problems/minimum-genetic-mutation/");
});

test("the full path and query are kept for ordinary hosts", () => {
  const r = scrubUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s");
  assert.equal(r.host, "www.youtube.com");
  // The video id IS the identity of the distraction — hostname-only would say
  // nothing at all about what he was watching.
  assert.match(r.url, /v=dQw4w9WgXcQ/);
  assert.match(r.url, /t=42s/);
});

test("credential-bearing params are redacted, neighbours untouched", () => {
  const r = scrubUrl(
    "https://app.example.com/callback?code=abc123&state=xyz&next=/dashboard&access_token=sekrit"
  );
  assert.match(r.url, /code=REDACTED/);
  assert.match(r.url, /state=REDACTED/);
  assert.match(r.url, /access_token=REDACTED/);
  assert.match(r.url, /next=%2Fdashboard/, "a non-secret param keeps its value");
  assert.ok(!r.url.includes("abc123"));
  assert.ok(!r.url.includes("sekrit"));
});

test("the fragment is always dropped (implicit-flow tokens live there)", () => {
  const r = scrubUrl("https://example.com/x#access_token=sekrit&expires_in=3600");
  assert.equal(r.url, "https://example.com/x");
  assert.ok(!r.url.includes("sekrit"));
});

test("substring matching covers the token family without a list entry each", () => {
  for (const name of ["access_token", "id_token", "refresh_token", "X-Amz-Security-Token"]) {
    assert.equal(isSecretParam(name), true, name);
  }
  for (const name of ["api_key", "apiKey", "client_secret", "session_id", "signature", "auth"]) {
    assert.equal(isSecretParam(name), true, name);
  }
});

test("short exact-match names do not eat innocent params", () => {
  // "code"/"key"/"state" are secrets; the words that CONTAIN them are not.
  assert.equal(isSecretParam("code"), true);
  assert.equal(isSecretParam("zipcode"), false);
  assert.equal(isSecretParam("key"), true);
  assert.equal(isSecretParam("keyword"), false);
  assert.equal(isSecretParam("state"), true);
  assert.equal(isSecretParam("real_estate"), false);
});

test("the scrub list is overridable without a rebuild", () => {
  const config = { substrings: ["nonce"], exact: [] };
  const r = scrubUrl("https://example.com/?nonce=abc&code=keepme", config);
  assert.match(r.url, /nonce=REDACTED/);
  // A caller-supplied list REPLACES the defaults — otherwise it isn't editable.
  assert.match(r.url, /code=keepme/);
});

test("browser-internal and non-web URLs are not recorded at all", () => {
  for (const u of [
    "chrome://extensions/",
    "chrome-extension://abcdef/options.html",
    "about:blank",
    "file:///Users/dani/secrets.txt",
    "devtools://devtools/bundled/inspector.html",
    "",
    null,
    "not a url",
  ]) {
    assert.equal(scrubUrl(u), null, String(u));
  }
});

test("hostnames are lowercased so one host is one row", () => {
  assert.equal(scrubUrl("https://LeetCode.COM/problems/x/").host, "leetcode.com");
});
