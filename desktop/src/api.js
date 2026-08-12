/**
 * The shell's own calls to Gooni, made from the MAIN process.
 *
 * Deliberately not from the capture renderer: the backend's CORS is an
 * allowlist (`ALLOWED_ORIGINS`, app/main.py), so a `file://` capture page
 * fetching the API would be blocked, and widening the server's allowlist to
 * accommodate a desktop window would weaken it for the web app too. Node has no
 * CORS, so the renderer sends text over IPC and this module does the HTTP.
 *
 * The capture path mirrors what the ambient home does (`createConversation` +
 * `sendConversationMessage` in frontend/src/services/api.ts) so a captured
 * thought goes through the same orchestrator — extraction, glow, memory — as
 * one typed into the wave. Capture that bypassed the pipeline would be a note
 * dropped in a drawer.
 */

const { assistantReply } = require("./reply");

/** Reuse one conversation for a stretch, then start fresh, like a chat session. */
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

class GooniApi {
  constructor({ getBaseUrl, getToken, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.getBaseUrl = getBaseUrl;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.conversationId = null;
    this.conversationAt = 0;
  }

  async _request(path, { method = "GET", body = null } = {}) {
    const base = String(this.getBaseUrl() || "").replace(/\/+$/, "");
    const token = this.getToken();
    if (!base) throw new Error("No backend URL configured");
    if (!token) {
      // Named, not swallowed: the caller turns this into "sign in to Gooni",
      // which is actionable. A generic 401 is not.
      const err = new Error("not_authenticated");
      err.code = "not_authenticated";
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      const err = new Error("not_authenticated");
      err.code = "not_authenticated";
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Gooni returned ${res.status}`);
      err.code = `http_${res.status}`;
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async _conversation() {
    const fresh = this.conversationId && this.now() - this.conversationAt < CONVERSATION_TTL_MS;
    if (fresh) return this.conversationId;
    const conv = await this._request("/conversations", { method: "POST", body: { content: "" } });
    this.conversationId = conv.id;
    this.conversationAt = this.now();
    return this.conversationId;
  }

  /**
   * Send a captured thought. Returns { reply, conversationId }.
   *
   * A stale conversation id (the row was deleted, or the server was rebuilt) is
   * retried ONCE against a fresh conversation rather than surfacing as a 404 —
   * the thought is already typed, and losing it to bookkeeping would be the
   * worst possible failure for a capture box.
   */
  async capture(text) {
    const content = String(text || "").trim();
    if (!content) throw new Error("Nothing to send");

    const send = async (convId) =>
      this._request(`/conversations/${convId}/messages`, {
        method: "POST",
        body: { role: "user", content },
      });

    let convId = await this._conversation();
    let payload;
    try {
      payload = await send(convId);
    } catch (e) {
      if (e.status !== 404) throw e;
      this.conversationId = null;
      convId = await this._conversation();
      payload = await send(convId);
    }
    return { reply: assistantReply(payload), conversationId: convId };
  }

  /** Cheap reachability probe for the tray's "backend" line. */
  async ping() {
    const base = String(this.getBaseUrl() || "").replace(/\/+$/, "");
    const started = this.now();
    const res = await this.fetchImpl(`${base}/health`, { method: "GET" });
    return { ok: res.ok, status: res.status, latencyMs: this.now() - started };
  }
}

module.exports = { GooniApi, CONVERSATION_TTL_MS };
