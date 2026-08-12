/**
 * The capture overlay's behaviour.
 *
 * Rules it exists to enforce, all versions of "never lose the thought":
 *  - the text is NOT cleared until the send succeeds, so a failed send leaves
 *    it on screen to retry rather than swallowing it;
 *  - closing while text is unsent keeps the text for the next summon;
 *  - "not signed in" is stated on open, not discovered after typing a paragraph
 *    and pressing enter.
 */

const input = document.getElementById("input");
const reply = document.getElementById("reply");
const banner = document.getElementById("banner");
const bannerText = document.getElementById("bannerText");
const bannerAction = document.getElementById("bannerAction");
const target = document.getElementById("target");
const panel = document.getElementById("panel");

let busy = false;

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

function fit() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  // The window is sized to its content so a one-line thought gets a one-line
  // box; +20 covers the panel's 10px margins.
  window.gooniCapture.resize(panel.getBoundingClientRect().height + 20);
}

function showReply(text, className = "") {
  reply.textContent = text;
  reply.className = `reply ${className}`.trim();
  reply.hidden = !text;
  fit();
}

function applyState(state) {
  target.textContent = host(state.apiUrl);
  const signedIn = Boolean(state.signedIn);
  banner.hidden = signedIn;
  if (!signedIn) {
    bannerText.textContent = "Not signed in — capture can't send yet.";
  }
  fit();
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true;
  showReply("thinking…", "muted");
  const res = await window.gooniCapture.send(text);
  busy = false;

  if (!res.ok) {
    showReply(res.error || "Send failed.", "error");
    // Text deliberately kept: it is the only copy that exists.
    return;
  }
  input.value = "";
  fit();
  const { reply: r } = res;
  if (r.text) showReply(r.text);
  else showReply(r.note || "Captured.", "muted");
}

input.addEventListener("input", fit);

input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    window.gooniCapture.hide();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

bannerAction.addEventListener("click", () => window.gooniCapture.openApp());

window.gooniCapture.onOpened((state) => {
  applyState(state);
  // A reply from a previous summon is stale context, but unsent TEXT is not —
  // only the reply is cleared.
  showReply("");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  fit();
});

window.gooniCapture.onClosed(() => {
  showReply("");
});

window.gooniCapture.state().then(applyState);
fit();
