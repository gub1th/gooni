/**
 * "Is this sensor actually delivering?" as one answer, rendered on the toolbar
 * icon.
 *
 * The extension was already careful never to LOSE data — the buffer retains
 * through every failure it can't prove is permanent. What it had no way to say
 * was that it had stopped delivering. Every failure mode is invisible unless
 * you open the options page and read a flush record:
 *
 *   - the default `baseUrl` pointed at http://localhost:8000, a backend that
 *     only exists while dev.sh is running, so a fresh install buffered against
 *     nothing and looked fine (that default is now the deployed backend —
 *     see config.js);
 *   - with no token saved, `flushOnce` returns `not_configured` with `sent: 0`,
 *     and `recordFlush` deliberately does not persist zero-sent flushes, so
 *     `gooni_last_flush` stays null FOREVER while the buffer grows. The options
 *     page shows nothing because there is nothing to show;
 *   - a wrong host 404s and retains, correctly, and silently.
 *
 * So health is computed primarily from CONFIG and BUFFER, not from the last
 * flush record — the worst states are exactly the ones that never write one.
 *
 * Chrome-free so the wording is testable, same split as status.js/format.js.
 */

/** Badge glyphs. Chrome renders ~4 characters; these are one on purpose. */
const BADGE = { error: "!", warn: "!", paused: "‖", ok: "" };
const COLOR = { error: "#c0392b", warn: "#b8860b", paused: "#666666", ok: "#00000000" };

/**
 * Buffered intervals that, with no successful flush behind them, mean this is a
 * standing outage rather than a blip. ~25 intervals is under an hour of normal
 * browsing, which is about how long you would tolerate not knowing.
 */
const STALE_BUFFER = 25;

/** Wire errors worth translating, because the fix is not obvious from the code. */
const ERROR_HELP = {
  unauthorized: "Gooni rejected the saved password",
  not_configured: "no password saved",
  retry_after: "Gooni asked us to slow down",
  flush_timeout: "Gooni accepted the connection then went quiet",
};

function explain(error) {
  if (!error) return "";
  if (ERROR_HELP[error]) return ERROR_HELP[error];
  if (error.startsWith("http_404")) return "nothing is listening at that address";
  if (error.startsWith("http_5")) return "Gooni returned a server error";
  if (error.startsWith("http_")) return `Gooni returned ${error.slice(5)}`;
  return "couldn't reach Gooni";
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "");
  }
}

/**
 * @param {object} s  the `gooni:status` shape (enabled, baseUrl, hasToken,
 *                    buffered, dropped, refused, lastFlush)
 * @returns {{level:string, badge:string, color:string, title:string, message:string|null}}
 */
export function sensorHealth(s = {}) {
  const buffered = Number(s.buffered) || 0;
  const dropped = Number(s.dropped) || 0;
  const refused = Number(s.refused) || 0;
  const lastError = s.lastFlush?.error || null;

  // Paused first: it is the one bad-looking state that is a deliberate choice,
  // and reporting a chosen pause as a failure trains you to ignore the badge.
  if (s.enabled === false) {
    return level("paused", "Sensing is paused", `Paused in options. ${buffered} interval(s) held.`);
  }

  if (!s.hasToken) {
    // The silent one. Nothing is ever delivered and no flush record is written,
    // so without this the extension looks identical to a healthy install.
    return level(
      "error",
      "Gooni sensor: not connected",
      `No Gooni password saved — nothing can be delivered. ${buffered} interval(s) waiting.`
    );
  }

  if (lastError === "unauthorized") {
    return level(
      "error",
      "Gooni sensor: password rejected",
      `Gooni rejected the saved password. ${buffered} interval(s) waiting; fix it in options and they'll be sent.`
    );
  }

  if (lastError && lastError !== "retry_after" && buffered >= STALE_BUFFER) {
    return level(
      "error",
      "Gooni sensor: not delivering",
      `${explain(lastError)} (${host(s.baseUrl)}). ${buffered} interval(s) waiting.`
    );
  }

  if (lastError && lastError !== "retry_after") {
    return level("warn", "Gooni sensor: last send failed", `${explain(lastError)} (${host(s.baseUrl)}).`);
  }

  // Loss that already happened. Lower priority than a live outage — nothing can
  // be done about it — but it must not vanish just because delivery recovered.
  if (refused > 0 || dropped > 0) {
    const parts = [];
    if (refused > 0) parts.push(`${refused} destroyed by the server`);
    if (dropped > 0) parts.push(`${dropped} lost to buffer overflow`);
    return level("warn", "Gooni sensor: some intervals were lost", `${parts.join("; ")}.`);
  }

  return level("ok", `Gooni usage — ${host(s.baseUrl)}`, null);
}

function level(name, title, message) {
  return { level: name, badge: BADGE[name], color: COLOR[name], title, message };
}

export { STALE_BUFFER, BADGE, COLOR };
