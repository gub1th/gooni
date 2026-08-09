/**
 * URL scrubbing — the extension's only privacy mechanism.
 *
 * The full URL of every host is captured on purpose: the question this sensor
 * answers is "what was I distracted BY", and hostname-only data cannot answer
 * it. A YouTube video id lives in `?v=`, a LeetCode problem in the path — both
 * must survive.
 *
 * The one thing that must never land in the log is a credential. OAuth
 * callbacks, magic links and password-reset links carry live secrets in the
 * query string, and a log of them is a log of ways into Daniel's accounts. So
 * every param whose NAME looks credential-bearing has its VALUE replaced with
 * `REDACTED` before the URL is buffered, and the fragment is dropped entirely
 * (implicit-flow OAuth returns `#access_token=…` there and a fragment carries
 * no identity worth the risk).
 *
 * THE MATCHER IS THREE CHECKS. A name is redacted if ANY of them fires. Each
 * exists because the two simpler designs this went through were wrong in
 * opposite directions, and neither direction is acceptable: over-redaction
 * destroys the value before the interval is buffered (unrecoverable), and
 * under-redaction stores a live credential.
 *
 *  1. SQUASHED WHOLE-NAME (`SCRUB_SQUASHED_NAMES`). Lowercase, delete every
 *     `_`/`-`, compare to the glued set. This is the only check that can catch
 *     a run-together name with no boundary at all (`jsessionid`, `phpsessid`,
 *     `csrftoken`), and it is also what keeps `api_key` covered once `key`
 *     stops being a segment (check 2). It cannot touch the innocent compounds:
 *     zip_code→zipcode, country-code→countrycode, sort_key→sortkey,
 *     us_state→usstate, page_state→pagestate are none of them in the set.
 *  2. WHOLE-NAME ONLY (`SCRUB_WHOLE_NAMES`: code, key, state). A bare `?code=`
 *     or `?state=` is the OAuth pair and must go. These three are deliberately
 *     ABSENT from the segment set — as segments they redacted `zip_code`,
 *     `country-code`, `error_code`, `promo_code`, `sort_key`, `product_key`,
 *     `us_state`, `page_state`, ordinary params on real sites.
 *  3. SEGMENT (`SCRUB_SEGMENTS`). Lowercase, split on `_`, `-`, camelCase
 *     boundaries and digit boundaries, redact if any piece is in the set. The
 *     camelCase split is load-bearing, not tidiness: without it `accessToken`,
 *     `idToken`, `authToken`, `sessionId` and `clientSecret` all sailed through
 *     and a live bearer token landed in the log verbatim. Segments are what
 *     keep the list short without substring collateral — `auth` catches
 *     `my_auth_token` but not `author`/`authors`, `sig` catches
 *     `x-amz-signature` but not `assignee`/`design`/`designer`/`insight`.
 *
 * `app/services/browser_activity_service.py` implements the SAME three checks
 * over the same three sets — that copy is the floor, and a floor that matched
 * differently would not be one. Both sides are pinned by the same literal
 * KEPT/REDACTED table (extension/tests/scrub.test.js and
 * tests/test_browser_intervals.py) so they can be diffed by eye.
 *
 * EDITING THE LIST: `SCRUB_SEGMENTS` — the family list, check 3 — is the
 * editable one. It can be overridden at runtime from the options page without a
 * rebuild: `loadConfig()` in config.js reads the saved list, and a saved list
 * REPLACES the default rather than extending it (an editable list you can only
 * add to isn't editable). The options page seeds its textarea with these
 * defaults, so the normal edit is "defaults plus mine" — but a list saved
 * without them loses them. Checks 1 and 2 are structural rather than editorial
 * (names with no boundary to split on; the three bare OAuth params) and stay
 * fixed. The server-side floor is NOT user-editable at all, so trimming
 * anything here narrows what the extension redacts and never gets under that
 * floor.
 */

/**
 * Check 3. Credential-bearing NAME SEGMENTS — one entry covers a family without
 * eating innocent words. `code`, `key` and `state` are deliberately NOT here;
 * they live in SCRUB_WHOLE_NAMES.
 */
export const SCRUB_SEGMENTS = [
  "auth",
  "authorization",
  "credential",
  "sig",
  "signature",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "session",
  "otp",
];

/** Check 2. Matched against the WHOLE name only — the bare OAuth params. */
export const SCRUB_WHOLE_NAMES = ["code", "key", "state"];

/**
 * Check 1. Matched after deleting every `_`/`-`, so it covers both the
 * run-together spellings and their separated forms (`api_key` → `apikey`).
 */
export const SCRUB_SQUASHED_NAMES = [
  "jsessionid",
  "phpsessid",
  "sessionid",
  "csrftoken",
  "accesstoken",
  "apikey",
  // The `x-`-prefixed API-key family walks past all three checks otherwise:
  // `key` is whole-name-only (check 2, which is what keeps `sort_key`), so
  // `x-api-key` has no matching segment and its squashed form is `xapikey`,
  // not `apikey`. Entries here MUST be pre-squashed — a literal `x-api-key`
  // would never match and would look like a fix without being one.
  "xapikey",
  "xfunctionskey",
  "subscriptionkey",
];

export const REDACTED = "REDACTED";

const WHOLE_SET = new Set(SCRUB_WHOLE_NAMES);
const SQUASHED_SET = new Set(SCRUB_SQUASHED_NAMES);

/** Lowercase a param name with every `_`/`-` deleted. */
export function squashName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[_-]+/g, "");
}

/**
 * Split a param name into its lowercase segments, on `_`, `-`, camelCase
 * boundaries and digit boundaries. Mirrored exactly in the server floor's
 * `_param_segments`.
 */
export function paramSegments(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

/** True if a query param's value should be redacted. */
export function isSecretParam(name, config = {}) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return false;
  if (SQUASHED_SET.has(squashName(lower))) return true;
  if (WHOLE_SET.has(lower)) return true;
  const segments = config.segments || SCRUB_SEGMENTS;
  const set = new Set(segments.map((s) => String(s).trim().toLowerCase()));
  return paramSegments(name).some((seg) => set.has(seg));
}

/**
 * Scrub one URL. Returns { url, host, path } — or null for a URL we can't or
 * shouldn't record (chrome://, about:, extension pages, unparseable input).
 *
 * A null return means "no interval here": internal browser pages are not
 * attention worth logging and have no meaningful host.
 */
export function scrubUrl(raw, config = {}) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // Only real web navigation counts. chrome://, chrome-extension://, about:,
  // file:, devtools:, view-source: are either the browser's own furniture or
  // local disk paths that have no business in a remote log.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;

  const params = new URLSearchParams(u.search);
  const out = new URLSearchParams();
  for (const [k, v] of params.entries()) {
    out.append(k, isSecretParam(k, config) ? REDACTED : v);
  }
  const query = out.toString();
  const path = u.pathname || "/";
  const url = `${u.protocol}//${u.host}${path}${query ? `?${query}` : ""}`;

  return { url, host: u.hostname.toLowerCase(), path };
}
