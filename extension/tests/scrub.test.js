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
 * THE MATCHING TABLE. This is the regression net, not an illustration — the
 * list has now broken in three different directions:
 *
 *  - substring matching over-redacted (`auth`→`author`, `sig`→`assignee`)
 *  - pure segment matching leaked every camelCase name (`accessToken`)
 *  - whole-name-only would have dropped `api_key`
 *
 * so every name is pinned by literal, in the SAME ORDER as the identical table
 * in tests/test_browser_intervals.py — the server floor must agree case for
 * case, and the two lists are meant to be diffable by eye.
 */
const KEPT = [
  "assignee", "author", "authors", "design", "designer", "insight",
  "zip_code", "country-code", "error_code", "promo_code",
  "sort_key", "product_key", "us_state", "page_state",
  // Extras beyond the pinned list, same spirit.
  "zipcode", "keyword", "real_estate", "v", "next", "t",
];

const REDACTED_NAMES = [
  "auth", "sig", "token", "password", "secret", "code", "key", "state",
  "auth_token", "access_token", "id_token", "api_key", "x-amz-signature",
  "accessToken", "idToken", "authToken", "sessionId", "clientSecret",
  "jsessionid", "phpsessid", "csrftoken",
  "x-api-key", "xApiKey", "X-Api-Key", "x_api_key", "x-functions-key",
  "subscription-key",
  // Extras beyond the pinned list, same spirit.
  "pwd", "otp", "passwd", "session", "apikey", "authorization", "credential",
  "signature", "client_secret", "session_id", "X-Amz-Security-Token",
  "refresh_token", "my_auth_token",
];

test("innocent param names keep their values", () => {
  for (const name of KEPT) {
    assert.equal(isSecretParam(name), false, `${name} must NOT be redacted`);
    // …and through the real entry point, so a refactor that bypasses the
    // matcher is caught too.
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

test("each of the three checks is load-bearing on its own", () => {
  // 1. squashed whole-name — the only thing that can catch a name with no
  //    boundary at all, and what keeps api_key covered now that `key` is not a
  //    segment.
  assert.equal(isSecretParam("jsessionid"), true);
  assert.equal(isSecretParam("api_key"), true);
  assert.equal(isSecretParam("apiKey"), true);
  // The `x-` prefixed family reaches this check and NOTHING else: `key` is
  // whole-name-only (check 2) and absent from the segment set (check 3), so
  // `x-api-key` has no matching segment and squashes to `xapikey`, not
  // `apikey`. Entries in the set must therefore be pre-squashed.
  assert.equal(isSecretParam("x-api-key"), true);
  assert.equal(isSecretParam("x-functions-key"), true);
  assert.equal(isSecretParam("subscription-key"), true);
  // 2. whole-name only — bare OAuth params go, their compounds stay.
  assert.equal(isSecretParam("code"), true);
  assert.equal(isSecretParam("zip_code"), false);
  assert.equal(isSecretParam("key"), true);
  assert.equal(isSecretParam("sort_key"), false);
  assert.equal(isSecretParam("state"), true);
  assert.equal(isSecretParam("us_state"), false);
  // 3. segments, including camelCase and digit boundaries — nobody has to have
  //    predicted the compound for it to be caught.
  assert.equal(isSecretParam("my_auth_token"), true);
  assert.equal(isSecretParam("gh-session-key"), true);
  assert.equal(isSecretParam("clientSecret"), true);
  assert.equal(isSecretParam("sha256Sig"), true);
  // …while the same rule leaves a compound of innocent words alone.
  assert.equal(isSecretParam("sort-by-author"), false);
  assert.equal(isSecretParam("design_system"), false);
});

test("the segment list is overridable without a rebuild", () => {
  const config = { segments: ["nonce"] };
  const r = scrubUrl("https://example.com/?nonce=abc&topic=keepme", config);
  assert.match(r.url, /nonce=REDACTED/);
  // A caller-supplied list REPLACES the segment defaults — otherwise it isn't
  // editable. `token` is gone from the set here, so a name reachable ONLY
  // through the segment check keeps its value.
  assert.match(r.url, /topic=keepme/);
  assert.equal(isSecretParam("refresh_token", config), false);
  // …but `access_token` squashes to `accesstoken`, which check 1 still catches.
  assert.equal(isSecretParam("access_token", config), true);
});

test("trimming the editable list cannot switch off the structural checks", () => {
  // Checks 1 and 2 are not editorial — a name with no boundary to split on and
  // the three bare OAuth params. An empty segment list must not disable them.
  const config = { segments: ["nonce"] };
  const r = scrubUrl("https://example.com/cb?code=abc&jsessionid=xyz", config);
  assert.match(r.url, /code=REDACTED/);
  assert.match(r.url, /jsessionid=REDACTED/);
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
