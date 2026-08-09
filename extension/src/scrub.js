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
 * MATCHING IS BY SEGMENT, not substring and not whole-name. The param name is
 * lowercased, split on `_` and `-`, and redacted if ANY segment is in
 * SCRUB_SEGMENTS. Substring matching was the first cut and it was wrong in a
 * way that silently destroyed data: `auth` matched `author`/`authors`, and
 * `sig` matched `assignee`/`design`/`designer`/`insight` — real params on real
 * sites (GitHub issue filters, blog author filters), whose values were gone
 * before the interval was ever buffered and therefore unrecoverable. Whole-name
 * matching would fix that by giving up the family coverage that makes the list
 * short; segments keep both, so a novel compound like `my_auth_token` is still
 * caught while `assignee` is not.
 *
 * `app/services/browser_activity_service.py` implements the SAME algorithm over
 * the same segments — that copy is the floor, and a floor that matched
 * differently would not be one.
 *
 * EDITING THE LIST: `SCRUB_SEGMENTS` below is the default. It can be overridden
 * at runtime from the options page without a rebuild — `loadConfig()` in
 * config.js reads the saved list, and a saved list REPLACES the default rather
 * than extending it (an editable list you can only add to isn't editable). The
 * options page seeds its textarea with these defaults, so the normal edit is
 * "defaults plus mine" — but a list saved without them loses them. The
 * server-side floor is NOT user-editable, so trimming a default here narrows
 * what the extension redacts but never gets under that floor.
 */

/**
 * Credential-bearing NAME SEGMENTS. One entry covers a family without eating
 * innocent words: `token` catches access_token, id_token, refresh_token and
 * X-Amz-Security-Token; `sig` catches `sig` itself but not `design`.
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
  "key",
  "apikey",
  "otp",
  "code",
  "state",
];

export const REDACTED = "REDACTED";

/** Lowercase a param name and split it into its `_`/`-` separated segments. */
export function paramSegments(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
}

/** True if a query param's value should be redacted. */
export function isSecretParam(name, config = {}) {
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
