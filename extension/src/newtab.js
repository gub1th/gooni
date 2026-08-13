/**
 * The new tab page's logic, with chrome and the DOM kept out of it.
 *
 * The page itself does one thing: frame the deployed Gooni frontend full-bleed,
 * so opening a tab lands on your own surface (the Momentum shape). The frontend
 * is NOT bundled into the extension — that would force a build step onto a
 * codebase that deliberately has none, and MV3 forbids remote code besides. In
 * the iframe the app runs on its OWN origin, so its auth token, its localStorage
 * and its calls to the backend are identical to a normal tab, and the backend
 * needs no change at all.
 *
 * What is actually worth testing here is the failure wording. A new tab is
 * opened dozens of times a day, so a blank one is the worst possible failure
 * mode for this feature: it gives you nothing to act on and no reason to
 * suspect anything is wrong. Same rule the popup follows for empty data and the
 * badge follows for a stalled sensor — the surface says what went wrong and
 * names the URL it tried, rather than sitting white.
 */

import { DEFAULT_APP_URL } from "./config.js";

/**
 * Permission delegation for the framed app. The ambient home is VOICE-FIRST
 * (tap-to-wake, continuous speech recognition), and a cross-origin iframe gets
 * no microphone unless the embedder hands it one — without this the wave
 * renders and simply never hears anything, which looks like the app being
 * broken rather than the frame withholding a permission.
 *
 * `autoplay` is the other half of voice: Gooni speaks its replies back through
 * TTS. Nothing else is delegated — the camera belongs to the focus-cam sidecar,
 * not to a browser tab.
 */
export const IFRAME_ALLOW = "microphone; autoplay; clipboard-write";

/**
 * How long to wait for the frame before calling it a failure.
 *
 * Generous on purpose: this is a cold cross-origin page load, and a slow
 * network that eventually paints the app is a far more common event than a
 * genuinely dead frontend. Crying failure over a slow load and then having the
 * app paint underneath the error is worse than waiting a beat.
 */
export const LOAD_TIMEOUT_MS = 12000;

/**
 * Normalise a configured app URL, or return null if it can't be framed.
 *
 * `null` is a real answer, not an error case to swallow: a saved value of
 * "localhost:5173" (no scheme) or a `chrome://` URL cannot be put in an iframe,
 * and the page must say so with the text the user actually typed rather than
 * silently falling back to the default and framing something they didn't ask
 * for.
 */
export function normalizeAppUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href.replace(/\/+$/, "") || parsed.origin;
}

/** The URL the tab should frame, falling back to the deployed app. */
export function resolveAppUrl(config) {
  return normalizeAppUrl(config?.appUrl) || DEFAULT_APP_URL;
}

/**
 * Read a frame-blocking verdict off response headers, or null if they permit
 * framing (or say nothing about it).
 *
 * This exists because a frame refused by `X-Frame-Options` or a
 * `frame-ancestors` directive is the ONE failure the timeout can't see: Chrome
 * fires the iframe's `load` event for its own blocked-frame error page, so the
 * page looks loaded and the tab is blank. Nothing blocks framing today — that
 * was verified before this was built — so this is here for the day a header
 * gets added upstream, and its job is to turn a blank tab into a sentence.
 *
 * `null` is also what an UNKNOWN answer returns, deliberately. The caller can
 * only read these headers where the extension holds a host permission; where it
 * doesn't, the fetch fails and we say nothing rather than guessing at a failure
 * the user can see isn't happening.
 *
 * @param {{ get(name: string): string | null }} headers
 */
export function frameBlockedBy(headers) {
  const xfo = String(headers?.get("x-frame-options") || "").trim().toLowerCase();
  // ALLOW-FROM is dead in Chrome, but DENY and SAMEORIGIN both block us: an
  // extension page is never the same origin as the app.
  if (xfo === "deny" || xfo === "sameorigin") return `X-Frame-Options: ${xfo}`;

  const csp = String(headers?.get("content-security-policy") || "");
  // Split on BOTH separators. A response can carry the header twice, and
  // `Headers.get` joins those with ", " — so the second policy's first
  // directive is not at the start of any ";"-delimited piece and a
  // `;`-only split walks straight past it. Source lists are space-separated,
  // never comma-separated, so nothing legitimate is cut here.
  const directives = csp
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => /^frame-ancestors(\s|$)/i.test(part));
  if (!directives.length) return null;

  // EVERY policy applies (a browser enforces their intersection), so the
  // strictest wins: one permissive `frame-ancestors *` cannot vouch for a
  // second policy that names an allowlist.
  for (const directive of directives) {
    const sources = directive.split(/\s+/).slice(1).map((s) => s.toLowerCase());
    // `*` permits any embedder; anything else is an allowlist that cannot name
    // a chrome-extension:// origin, so it excludes us however it is spelled.
    if (!sources.includes("*")) return `Content-Security-Policy: ${directive}`;
  }
  return null;
}

/**
 * What the probe's answer means for the page, given what the frame has done.
 *
 * The rule that matters: an already-painted frame WINS over an unreachable
 * verdict. The probe and the frame load race by design, and the probe can lose
 * a fight it had no business entering — the frame painting from HTTP cache
 * while a `no-store` probe hits a dropped network, or any transient reset
 * inside the load window. Tearing down a painted app for that would destroy
 * whatever the user had already typed into the capture box and replace a
 * working surface with an error panel.
 *
 * `blocked` is exempt, and deliberately so: a blocked frame FIRES `load` for
 * Chrome's own error page, so "painted" there means the opposite of working.
 * That is the one verdict the frame's own signal cannot be trusted against.
 */
export function probeVerdict({ reachable, blocked, framePainted }) {
  if (blocked) return "blocked";
  if (!reachable && !framePainted) return "unreachable";
  return null;
}

/**
 * Whether the stall timeout still has anything to say, given everything known
 * by the time it fires.
 *
 * The SAME rule as `probeVerdict`, on the other path — which is the whole
 * reason it lives here instead of inline at the timer. The timeout catches a
 * load that neither paints nor errors, and nothing else: a frame that has
 * already painted, or a probe that already found something answering, has
 * settled the question the timer was armed to ask. Letting it fire anyway
 * replaces a live surface with an error panel and throws away whatever was
 * typed into the capture box — a frame paints long before its `load` event
 * does when one subresource hangs, so "no load event at 12s" is not evidence
 * of a blank tab.
 *
 * `blocked` returns null because that verdict belongs to the probe, which
 * words it precisely; "didn't finish loading" over a frame Chrome refused to
 * embed is the wrong sentence, not a second opinion.
 */
export function stallVerdict({ reachable, blocked, framePainted } = {}) {
  if (framePainted) return null;
  if (blocked) return null;
  if (reachable) return null;
  return "timeout";
}

const REASONS = {
  invalid: {
    title: "That isn't a URL Gooni can open",
    detail:
      "The new tab needs a full http:// or https:// address. Set one in the extension's options page.",
  },
  unreachable: {
    title: "Couldn't reach Gooni",
    detail:
      "Nothing answered at that address. If it's a local dev server, check it's running; otherwise check the URL in the extension's options page.",
  },
  timeout: {
    title: "Gooni didn't finish loading",
    detail:
      "Nothing painted, and nothing confirmed the address was answering either. The load may have stalled, or the connection may be hanging.",
  },
  blocked: {
    title: "Gooni refused to be framed",
    detail:
      "The app sent a header that forbids embedding, so the new tab can't show it. Open it in a normal tab instead.",
  },
  // Reached when the settings themselves can't be read — chrome.storage rejects
  // while the extension is being reloaded or updated. There is no URL to name
  // because we never got as far as knowing which one to try, and saying so is
  // better than naming the default we didn't actually attempt.
  config: {
    title: "Gooni's settings couldn't be read",
    detail:
      "The extension couldn't load its own configuration, so it doesn't know which frontend to open. This usually means it was mid-reload — Retry, or reload the extension.",
  },
};

/**
 * The on-page failure text. Always carries the URL that was tried — "couldn't
 * load" on its own is unactionable, and the single most likely cause is that
 * the URL is pointed somewhere stale.
 */
export function frameFailure({ reason, url, note }) {
  const known = REASONS[reason] || REASONS.unreachable;
  const extra = String(note ?? "").trim();
  return {
    title: known.title,
    // The header itself, when we have it — "refused to be framed" is the
    // diagnosis, the directive is the thing you go and change.
    detail: extra ? `${known.detail} (${extra})` : known.detail,
    /** Shown verbatim, including an unparseable one — that IS the diagnosis. */
    url: String(url ?? "").trim() || "(no URL configured)",
  };
}
