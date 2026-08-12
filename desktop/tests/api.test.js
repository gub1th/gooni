const test = require("node:test");
const assert = require("node:assert/strict");

const { GooniApi } = require("../src/api");

function makeApi({ token = "tok", responses = [], baseUrl = "https://gooni-bot.fly.dev" } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
    };
  };
  const api = new GooniApi({
    getBaseUrl: () => baseUrl,
    getToken: () => token,
    fetchImpl,
    now: () => 1_000_000,
  });
  return { api, calls };
}

const CONV = { status: 200, body: { id: 7 } };
const TURN = {
  status: 200,
  body: { messages: [{ role: "assistant", content: "got it" }], tools_used: [] },
};

test("capture creates a conversation then posts the message, Bearer-authed", async () => {
  const { api, calls } = makeApi({ responses: [CONV, TURN] });
  const res = await api.capture("  ship the shell  ");

  assert.equal(calls[0].url, "https://gooni-bot.fly.dev/conversations");
  assert.equal(calls[1].url, "https://gooni-bot.fly.dev/conversations/7/messages");
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(calls[1].body, { role: "user", content: "ship the shell" });
  assert.equal(res.reply.text, "got it");
});

test("the conversation is reused across captures — one session, not one per thought", async () => {
  const { api, calls } = makeApi({ responses: [CONV, TURN, TURN] });
  await api.capture("one");
  await api.capture("two");
  assert.equal(calls.filter((c) => c.url.endsWith("/conversations")).length, 1);
});

test("a conversation the server no longer has is retried once against a fresh one", async () => {
  // The thought is already typed. Losing it to bookkeeping would be the worst
  // possible failure for a capture box.
  const { api, calls } = makeApi({ responses: [CONV, { status: 404 }, { status: 200, body: { id: 9 } }, TURN] });
  const res = await api.capture("still here");
  assert.equal(res.conversationId, 9);
  assert.equal(res.reply.text, "got it");
  assert.equal(calls.length, 4);
});

test("no token is a NAMED error, so the UI can say 'sign in' rather than '401'", async () => {
  const { api } = makeApi({ token: "", responses: [] });
  await assert.rejects(() => api.capture("hi"), (e) => e.code === "not_authenticated");
});

test("a 401 from the server maps to the same named error", async () => {
  const { api } = makeApi({ responses: [{ status: 401 }] });
  await assert.rejects(() => api.capture("hi"), (e) => e.code === "not_authenticated");
});

test("empty text is refused before any request", async () => {
  const { api, calls } = makeApi({ responses: [] });
  await assert.rejects(() => api.capture("   "));
  assert.equal(calls.length, 0);
});

test("a non-404 failure propagates instead of silently minting conversations", async () => {
  const { api, calls } = makeApi({ responses: [CONV, { status: 500 }] });
  await assert.rejects(() => api.capture("hi"), (e) => e.code === "http_500");
  assert.equal(calls.length, 2);
});
