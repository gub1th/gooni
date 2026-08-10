/**
 * The toolbar popup: what the sensor actually recorded, at a glance.
 *
 * READ-ONLY. It touches nothing in the sensing path (background/tracker/buffer)
 * beyond asking the service worker for its status, and it does no arithmetic
 * over raw intervals — every total, per-host row and per-day bar arrives
 * pre-folded from `GET /browser/intervals/summary`, which groups in SQL. A
 * popup that downloaded a week of tab switches and summed them in JavaScript
 * would be visibly slow within a month of ordinary browsing.
 *
 * Three states are deliberately distinct, because collapsing them is how a
 * dashboard starts lying:
 *
 *   not connected  — no token, so nothing could ever have been fetched
 *   error          — the fetch failed; we do NOT fall back to rendering zeros
 *   empty          — the server answered and there is nothing there
 *
 * "No data yet" and "you focused for 0 seconds" are different claims and this
 * file never confuses them.
 */

import { loadConfig } from "./src/config.js";
import {
  barPercent,
  dayLabel,
  formatDuration,
  formatHeadline,
  formatPercent,
  formatSessions,
  pendingNote,
  truncatedNote,
} from "./src/format.js";

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
};

const $ = (id) => document.getElementById(id);

/** Days of history behind the trend chart, regardless of the selected period. */
const TREND_DAYS = 7;

let period = 1;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function fetchSummary(cfg, days) {
  const url = `${cfg.baseUrl}/browser/intervals/summary?days=${days}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

/** The service worker's own view — buffered count, token presence. Optional:
 *  a popup opened while the worker is starting must still render the data. */
async function fetchStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: "gooni:status" });
  } catch {
    return null;
  }
}

function renderState(title, detail) {
  const box = el("div", "state");
  box.appendChild(el("strong", null, title));
  if (detail) box.appendChild(el("div", null, detail));
  $("body").replaceChildren(box);
}

function renderNotes(lines) {
  $("notes").replaceChildren(
    ...lines.filter(Boolean).map(({ text, warn }) => el("div", warn ? "note warn" : "note", text))
  );
}

function renderChart(days) {
  const chart = $("chart");
  const peak = Math.max(...days.map((d) => d.total_sec), 0);
  if (peak <= 0) {
    chart.hidden = true;
    return;
  }
  chart.hidden = false;

  const bars = days.map((d) => {
    const col = el("div", "col");
    if (d.total_sec <= 0) {
      // A flat rule rather than nothing: an absent bar reads as a missing day,
      // and a day with no browsing is a real observation.
      col.appendChild(el("div", "empty"));
    } else {
      const stack = el("div", "stack");
      stack.style.height = `${Math.max(3, (d.total_sec / peak) * 100)}%`;
      const salvaged = Math.min(d.truncated_sec, d.total_sec);
      const clean = d.total_sec - salvaged;
      // The salvaged share is hatched, in place, so the eye reads it as part of
      // the day's total AND as a different kind of number.
      if (salvaged > 0) {
        const hatch = el("div", "salvaged");
        hatch.style.height = `${(salvaged / d.total_sec) * 100}%`;
        stack.appendChild(hatch);
      }
      if (clean > 0) {
        const solid = el("div", "solid");
        solid.style.height = `${(clean / d.total_sec) * 100}%`;
        stack.appendChild(solid);
      }
      col.appendChild(stack);
    }
    col.title = `${d.date} — ${formatDuration(d.total_sec)}, ${formatSessions(d.sessions)}${
      d.truncated_sessions > 0 ? ` (${formatDuration(d.truncated_sec)} salvaged)` : ""
    }`;
    return col;
  });
  $("bars").replaceChildren(...bars);
  $("axis").replaceChildren(...days.map((d) => el("span", null, dayLabel(d.date))));
}

function faviconCell(host) {
  const cell = el("td", "icon");
  // chrome's own favicon cache (the `favicon` permission). No third-party
  // favicon service: that would ship every host Daniel visits to someone else,
  // which is precisely what this sensor's privacy model exists to avoid.
  const img = el("img");
  img.src = chrome.runtime.getURL(
    `/_favicon/?pageUrl=${encodeURIComponent(`https://${host}/`)}&size=32`
  );
  img.alt = "";
  img.addEventListener("error", () => {
    cell.replaceChildren(el("div", "letter", (host[0] || "?").toUpperCase()));
  });
  cell.appendChild(img);
  return cell;
}

function hostRow(h, total) {
  const row = el("tr");
  row.appendChild(faviconCell(h.host));

  const name = el("td", "name");
  name.appendChild(el("span", "host", h.host));
  const meta = el("span", "meta", formatSessions(h.sessions));
  if (h.truncated_sessions > 0) {
    meta.appendChild(document.createTextNode(" "));
    const flag = el("span", "flag", "⚑");
    flag.title =
      `${formatDuration(h.truncated_sec)} of this came from ` +
      `${formatSessions(h.truncated_sessions)} salvaged at a heartbeat — that ` +
      `time is a floor, not a measurement`;
    meta.appendChild(flag);
  }
  name.appendChild(meta);
  const track = el("div", "track");
  const fill = el("i");
  fill.style.width = `${barPercent(h.total_sec, total)}%`;
  track.appendChild(fill);
  name.appendChild(track);
  row.appendChild(name);

  const time = el("td", "time");
  time.appendChild(el("div", "dur", formatDuration(h.total_sec)));
  time.appendChild(el("div", "pct", formatPercent(h.total_sec, total)));
  row.appendChild(time);
  return row;
}

function renderHosts(summary) {
  const total = summary.totals.total_sec;
  const table = el("table");
  table.replaceChildren(...summary.hosts.map((h) => hostRow(h, total)));
  $("body").replaceChildren(table);
}

async function render() {
  for (const b of $("periods").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.days) === period));
  }

  const cfg = await loadConfig(storage);
  const status = await fetchStatus();

  if (!cfg.token) {
    $("headline").textContent = "—";
    $("chart").hidden = true;
    renderNotes([]);
    renderState("Not connected", "Save your Gooni password in settings first.");
    return;
  }

  let summary;
  let trend;
  try {
    summary = await fetchSummary(cfg, period);
    trend = period === TREND_DAYS ? summary : await fetchSummary(cfg, TREND_DAYS);
  } catch (e) {
    // No zeros on an error. A headline of "0s" because the server was
    // unreachable is a claim about Daniel's day that we cannot make.
    $("headline").textContent = "—";
    $("chart").hidden = true;
    renderNotes([]);
    renderState("Couldn't reach Gooni", `${cfg.baseUrl} — ${e.message}`);
    return;
  }

  const totals = summary.totals;
  // An em dash, not "0s". The headline is the loudest thing on the popup, and
  // "0s" is a measurement — it asserts a period was watched and held no
  // attention. Nothing recorded is a different statement, and the body below
  // makes it.
  $("headline").textContent =
    totals.sessions > 0 ? formatHeadline(totals.total_sec) : "—";
  $("range").textContent =
    summary.start === summary.end ? summary.start : `${summary.start} → ${summary.end}`;

  const pending = pendingNote(status);
  const salvaged = truncatedNote(totals);
  renderNotes([
    pending ? { text: pending, warn: true } : null,
    salvaged ? { text: salvaged, warn: true } : null,
  ]);

  renderChart(trend.days);

  if (totals.sessions === 0) {
    // Explicitly NOT "0 seconds of focus" — nothing was recorded for this
    // period, which is a different statement about the world.
    renderState(
      "No data yet",
      pending
        ? "Nothing recorded for this period; some intervals are still waiting to send."
        : "Nothing recorded for this period."
    );
    return;
  }

  renderHosts(summary);
}

$("periods").addEventListener("click", (e) => {
  const days = Number(e.target?.dataset?.days);
  if (!days || days === period) return;
  period = days;
  $("body").replaceChildren(el("div", "state", "loading…"));
  render();
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
