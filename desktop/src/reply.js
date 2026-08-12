/**
 * Pull Gooni's answer out of a `POST /conversations/:id/messages` payload.
 *
 * Split out and pure because the interesting case is the EMPTY one. The
 * response carries the whole turn's messages, and the assistant's content can
 * legitimately be blank (a turn whose work was entirely tool calls). Rendering
 * that as an empty bubble reads as "the send failed" — so the capture window
 * needs to distinguish "no reply text" from "no reply", and this is where that
 * distinction is decided rather than in DOM code.
 */

function assistantReply(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = String(m.content ?? "").trim();
    // An assistant turn with no prose still means the turn LANDED. Say what
    // happened rather than showing a blank box that looks like a dropped send.
    if (!text) return { text: "", landed: true, note: noteForTools(payload) };
    return { text, landed: true, note: null };
  }
  return { text: "", landed: false, note: "Gooni stored it but sent nothing back." };
}

function noteForTools(payload) {
  const tools = Array.isArray(payload?.tools_used) ? payload.tools_used.filter(Boolean) : [];
  if (tools.length) return `Captured — ${tools.join(", ")}`;
  return "Captured.";
}

module.exports = { assistantReply };
