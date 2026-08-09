/**
 * The options page's last-flush report.
 *
 * Chrome-free and DOM-free so the wording is testable, because the wording IS
 * the feature here. A rejected interval was acked and deleted from the buffer
 * like an accepted one — the server took a position on it — so this panel is
 * the only place the loss is ever visible. Printing "sent 200, accepted 0" and
 * nothing else renders permanent data loss as a successful flush.
 *
 * The reachable case with no bug anywhere: a machine whose clock runs more than
 * five minutes fast makes the server reject every row as `future`, forever,
 * while the extension keeps reporting healthy 2xx flushes.
 */

/** Reasons worth translating out of wire-speak, because the fix is not obvious. */
const REASON_HELP = {
  future:
    "this machine's clock is ahead of the server's — fix the clock or nothing will ever land",
  too_long: "intervals longer than 6h are refused as sensor errors",
  too_short: "sub-second intervals are dropped as tab-switch noise",
  missing_host: "rows arrived without a hostname",
  missing_client_id: "rows arrived without a client id",
  negative_duration: "rows arrived ending before they started",
};

/**
 * Render the last-flush result as display lines.
 *
 * @param {object|null} lastFlush  the stored `gooni_last_flush` blob
 * @returns {string[]} zero or more lines, already indented for the panel
 */
export function formatLastFlush(lastFlush, { formatTime = defaultFormatTime } = {}) {
  if (!lastFlush) return [];
  const f = lastFlush;
  const sent = f.sent ?? 0;
  const accepted = f.accepted ?? 0;
  const duplicates = f.duplicates ?? 0;
  const rejected = f.rejected ?? 0;

  const parts = [
    `sent ${sent}`,
    `accepted ${accepted}`,
    `duplicates ${duplicates}`,
    `rejected ${rejected}`,
  ];
  if (f.error) parts.push(`error ${f.error}`);
  const lines = [`last flush: ${formatTime(f.at)} — ${parts.join(", ")}`];

  if (rejected > 0) {
    const landed = accepted + duplicates;
    const reason = f.rejectedReason;
    const because = reason ? ` (${reason})` : "";
    lines.push(
      landed === 0
        ? `  ⚠ EVERY interval in that batch was REJECTED and discarded${because} — nothing was stored.`
        : `  ⚠ ${rejected} interval(s) were rejected and discarded${because}.`
    );
    if (reason && REASON_HELP[reason]) lines.push(`    ${REASON_HELP[reason]}`);
  }
  return lines;
}

function defaultFormatTime(at) {
  if (!at) return "unknown time";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleTimeString();
}
