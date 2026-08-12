const test = require("node:test");
const assert = require("node:assert/strict");

const { LogBuffer } = require("../src/logbuffer");

test("chunks that split a line mid-way are stitched, not logged as fragments", () => {
  const buf = new LogBuffer();
  buf.write("session ", "stdout");
  buf.write("started\nnext", "stdout");
  assert.deepEqual(buf.tail().map((l) => l.text), ["session started"]);
  buf.write(" line\n", "stdout");
  assert.deepEqual(buf.tail().map((l) => l.text), ["session started", "next line"]);
});

test("the two streams hold their partials separately", () => {
  const buf = new LogBuffer();
  buf.write("out-", "stdout");
  buf.write("err-", "stderr");
  buf.write("one\n", "stdout");
  buf.write("two\n", "stderr");
  assert.deepEqual(buf.tail().map((l) => `${l.stream}:${l.text}`), [
    "stdout:out-one",
    "stderr:err-two",
  ]);
});

test("flush emits the trailing fragment — a crash message often has no newline", () => {
  const buf = new LogBuffer();
  buf.write("Traceback (most recent call last):", "stderr");
  assert.equal(buf.tail().length, 0);
  buf.flush();
  assert.deepEqual(buf.tail().map((l) => l.text), ["Traceback (most recent call last):"]);
});

test("the ring evicts oldest and ADMITS it, so a tail isn't mistaken for the whole log", () => {
  const buf = new LogBuffer({ maxLines: 3 });
  for (let i = 1; i <= 5; i += 1) buf.write(`line ${i}\n`, "stdout");
  assert.deepEqual(buf.tail().map((l) => l.text), ["line 3", "line 4", "line 5"]);
  assert.equal(buf.dropped, 2);
  assert.match(buf.toText(), /2 earlier line\(s\) scrolled out/);
});

test("stderr is marked in the rendered text", () => {
  const buf = new LogBuffer();
  buf.write("fine\n", "stdout");
  buf.write("bad\n", "stderr");
  assert.equal(buf.toText(), "  fine\n! bad");
});

test("onLine fires per complete line, in order", () => {
  const seen = [];
  const buf = new LogBuffer({ onLine: (l) => seen.push(l.text) });
  buf.write("a\nb\n", "stdout");
  assert.deepEqual(seen, ["a", "b"]);
});
