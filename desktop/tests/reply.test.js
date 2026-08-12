const test = require("node:test");
const assert = require("node:assert/strict");

const { assistantReply } = require("../src/reply");

test("takes the last assistant message, not the user's own utterance", () => {
  const r = assistantReply({
    messages: [
      { role: "user", content: "remind me to call mum" },
      { role: "assistant", content: "noticed that one." },
    ],
  });
  assert.equal(r.text, "noticed that one.");
  assert.equal(r.landed, true);
});

test("an assistant turn with no prose still reads as LANDED", () => {
  // A turn whose work was entirely tool calls is a successful capture. Showing
  // an empty box would read as a dropped send.
  const r = assistantReply({ messages: [{ role: "assistant", content: "   " }], tools_used: ["log_note"] });
  assert.equal(r.landed, true);
  assert.equal(r.text, "");
  assert.equal(r.note, "Captured — log_note");
});

test("no assistant message at all is NOT reported as a reply", () => {
  const r = assistantReply({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.landed, false);
  assert.ok(r.note);
});

test("a malformed payload does not throw", () => {
  assert.equal(assistantReply(null).landed, false);
  assert.equal(assistantReply({}).landed, false);
  assert.equal(assistantReply({ messages: "nope" }).landed, false);
});
