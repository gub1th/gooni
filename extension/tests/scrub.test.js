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

/**
 * The matching table. Segment matching replaced substring matching because
 * `auth` ate `author`/`authors` and `sig` ate `assignee`/`design`/`designer`/
 * `insight` — real params on GitHub issue filters and blog author filters,
 * whose values were destroyed before the interval was ever buffered.
 *
 * Table-driven on purpose: a later edit to the credential set that
 * reintroduces over-redaction has to fail here by name.
 */
const KEPT = ["assignee", "author", "authors", "design", "designer", "insight",
  "zipcode", "keyword", "real_estate", "v", "next", "t"];

const REDACTED_NAMES = ["auth", "sig", "token", "password", "secret",
  "auth_token", "access_token", "id_token", "x-amz-signature", "api_key",
  "code", "key", "state", "pwd", "otp", "passwd", "session", "apikey",
  "authorization", "credential", "signature", "client_secret", "session_id",
  "X-Amz-Security-Token", "refresh_token", "my_auth_token"];

test("innocent param names keep their values", () => {
  for (const name of KEPT) {
    assert.equal(isSecretParam(name), false, `${name} must NOT be redacted`);
    // …and through the real entry point, not just the predicate.
    const r = scrubUrl(`https://example.com/x?${encodeURIComponent(name)}=dani`);
    assert.match(r.url, /=dani/, `${name} lost its value`);
  }
});

test("credential-bearing param names are redacted", () => {
  for (const name of REDACTED_NAMES) {
    assert.equal(isSecretParam(name), true, `${name} MUST be redacted`);
    const r = scrubUrl(`https://example.com/x?${encodeURIComponent(name)}=sekrit`);
    assert.ok(!r.url.includes("sekrit"), `${name} leaked its value: ${r.url}`);
    assert.match(r.url, /=REDACTED/, `${name} not marked redacted`);
  }
});

test("a novel compound is caught by its segments, not by an entry of its own", () => {
  // This is what segment matching buys over whole-name matching: nobody has to
  // have predicted `my_auth_token` for it to be caught.
  assert.equal(isSecretParam("my_auth_token"), true);
  assert.equal(isSecretParam("gh-session-key"), true);
  // …while the same rule leaves a compound of innocent words alone.
  assert.equal(isSecretParam("sort-by-author"), false);
  assert.equal(isSecretParam("design_system"), false);
});

test("the scrub list is overridable without a rebuild", () => {
  const config = { segments: ["nonce"] };
  const r = scrubUrl("https://example.com/?nonce=abc&code=keepme", config);
  assert.match(r.url, /nonce=REDACTED/);
  // A caller-supplied list REPLACES the defaults — otherwise it isn't editable.
  assert.match(r.url, /code=keepme/);
});

test("HTTP-basic credentials in the URL are never recorded", () => {
  // The extension rebuilds from u.host, which excludes userinfo. Pinned because
  // the server floor had exactly this hole and a rebuild from u.href would
  // reintroduce it here.
  for (const raw of [
    "https://alice:hunter2@intranet.example.com/dashboard",
    "https://alice:hunter2@intranet.example.com/dashboard?tab=1",
    "https://alice@intranet.example.com/dashboard",
  ]) {
    const r = scrubUrl(raw);
    assert.ok(!r.url.includes("hunter2"), `password stored: ${r.url}`);
    assert.ok(!r.url.includes("alice"), `username stored: ${r.url}`);
    assert.equal(r.host, "intranet.example.com");
  }
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
