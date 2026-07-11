import {
  type EvalMessage,
  type EvalSegmentFull,
} from "../../services/api";
import { RATING_LABEL_EVAL, SOURCE_STYLE } from "./evalShared";

// ── PDF export ───────────────────────────────────────────────────────────────
// window.print() on the live app DOM clipped to page 1 — the segment lives inside
// a flex/overflow:hidden shell that print CSS couldn't fully release. Instead we
// serialize the whole segment to a standalone HTML doc and print THAT in a hidden
// iframe, so every message + all reviewer feedback paginates cleanly.

function escHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

function renderPrintMessage(m: EvalMessage): string {
  const ts = m.created_at ? new Date(m.created_at).toLocaleString() : "";
  const roleClass = m.role === "assistant" ? "assistant" : "user";
  const fb = m.is_feedback ? " · feedback" : "";
  let extras = "";

  if (m.rating && (m.rating.rating != null || m.rating.comment)) {
    const lbl =
      m.rating.rating != null ? RATING_LABEL_EVAL[m.rating.rating] : "no rating";
    extras += `<div class="rating">Rating: <b>${escHtml(lbl)}</b></div>`;
    if (m.rating.comment)
      extras += `<div class="comment">${escHtml(m.rating.comment)}</div>`;
  }

  if (m.reflection) {
    const rf = m.reflection;
    extras += `<div class="aside"><b>Self-take</b> · sev ${escHtml(rf.severity)}`;
    if (rf.gap_exposed) extras += `<div>Gap: ${escHtml(rf.gap_exposed)}</div>`;
    if (rf.proposed_self_fix)
      extras += `<div>Fix: ${escHtml(rf.proposed_self_fix)}</div>`;
    if (rf.critique_summary)
      extras += `<div>Critique: ${escHtml(rf.critique_summary)}</div>`;
    extras += `</div>`;
  }

  if (m.step_feedback?.length) {
    const lines = m.step_feedback
      .map(
        (s) =>
          `<div>· ${escHtml(s.step_key)}: <b>${escHtml(
            RATING_LABEL_EVAL[s.rating] ?? s.rating,
          )}</b>${s.comment ? ` — ${escHtml(s.comment)}` : ""}</div>`,
      )
      .join("");
    extras += `<div class="aside"><b>Step feedback</b>${lines}</div>`;
  }

  const toolNames = (m.tool_calls ?? []).map((t) => t.tool_name).filter(Boolean);
  const traceN = m.trace?.length ?? 0;
  if (toolNames.length || traceN) {
    const bits: string[] = [];
    if (traceN) bits.push(`trace: ${traceN} steps`);
    if (toolNames.length)
      bits.push(`tools: ${toolNames.map(escHtml).join(", ")}`);
    extras += `<div class="trace">${bits.join(" · ")}</div>`;
  }

  return `<div class="msg ${roleClass}">
    <div class="head"><span class="role ${roleClass}">${escHtml(
      m.role,
    )}</span> <span class="ts">#${escHtml(m.id)} · ${escHtml(ts)}${fb}</span></div>
    <div class="content">${escHtml(m.content)}</div>
    ${extras}
  </div>`;
}

function buildSegmentPrintHtml(data: EvalSegmentFull): string {
  const seg = data.segment;
  const msgs = data.messages;
  const tally: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  for (const m of msgs) {
    const r = m.rating?.rating;
    if (r === 1 || r === 2 || r === 3) tally[r] += 1;
  }
  const sourceLabel = SOURCE_STYLE[seg.source]?.label ?? seg.source;
  const cost =
    seg.cost_usd != null ? ` · $${seg.cost_usd.toFixed(4)}` : "";
  const overall = seg.overall_comment
    ? `<div class="overall"><div class="lbl">Overall</div><div class="body">${escHtml(
        seg.overall_comment,
      )}</div></div>`
    : "";
  const cards = msgs.map(renderPrintMessage).join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Segment #${seg.id} — eval</title>
<style>
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1c1e; margin: 0; }
  h1 { font-size: 17px; margin: 0 0 2px; }
  h1 .muted { color: #8e8e93; font-weight: 400; font-size: 13px; }
  .meta { color: #6b7280; font-size: 11px; margin-bottom: 16px; }
  .overall { border: 1px solid #d2d2d7; border-radius: 8px; padding: 8px 12px; margin-bottom: 18px; }
  .overall .lbl { font-weight: 600; font-size: 11px; margin-bottom: 4px; }
  .overall .body { white-space: pre-wrap; font-size: 12px; }
  .msg { border: 1px solid #e5e5ea; border-radius: 8px; padding: 9px 12px; margin-bottom: 9px; page-break-inside: avoid; }
  .msg.assistant { border-left: 3px solid #0a84ff; }
  .head { margin-bottom: 5px; }
  .role { font-weight: 600; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: #3c3c43; }
  .role.assistant { color: #0a84ff; }
  .ts { color: #aeaeb2; font-size: 10px; }
  .content { white-space: pre-wrap; word-break: break-word; }
  .rating { margin-top: 7px; font-size: 11px; }
  .comment { margin-top: 4px; font-size: 11px; background: #f6f8fa; border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
  .aside { margin-top: 7px; padding-top: 6px; border-top: 1px dashed #e0e0e0; font-size: 11px; color: #444; }
  .aside div { margin-top: 2px; }
  .trace { margin-top: 6px; font-size: 10px; color: #8e8e93; }
</style></head><body>
  <h1>Segment #${escHtml(seg.id)} <span class="muted">· ${escHtml(
    sourceLabel,
  )} · ${escHtml(seg.eval_status)}</span></h1>
  <div class="meta">${msgs.length} messages · ${tally[3]} good / ${
    tally[2]
  } neutral / ${tally[1]} bad${cost}</div>
  ${overall}
  ${cards}
</body></html>`;
}

export function printSegmentPdf(data: EvalSegmentFull): void {
  const html = buildSegmentPrintHtml(data);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
    visibility: "hidden",
  });
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };
    win.onafterprint = cleanup;
    win.focus();
    win.print();
    // Save-as-PDF doesn't always fire onafterprint — fallback sweep.
    setTimeout(cleanup, 60_000);
  };
  document.body.appendChild(iframe);
  iframe.srcdoc = html;
}
