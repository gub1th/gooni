/**
 * The shape a quick capture takes when it becomes a note.
 *
 * The rule itself is old — the ambient box has split "first line = title, rest =
 * body" on ⌘↵ since it was a plain textarea. What is new is that the box's
 * EXPANDED note editor writes through the same rule, so the two doors of one
 * composer can't produce differently-shaped notes. These pin the cases where
 * "the first line" is not a line of prose, each of which would otherwise lose
 * content rather than merely title it oddly.
 */
import { describe, expect, test } from "vitest";
import { hasRichContent, splitTitleAndBody, textToParagraphs } from "./quickNote";

describe("splitTitleAndBody", () => {
  test("lifts the first block as the title and keeps the rest as the body", () => {
    const { title, body } = splitTitleAndBody(
      "<p>capture rethink</p><ul><li><p>keep the home visible</p></li></ul>",
    );
    expect(title).toBe("capture rethink");
    expect(body).toBe("<ul><li><p>keep the home visible</p></li></ul>");
  });

  test("a single block titles the note and leaves the body empty", () => {
    expect(splitTitleAndBody("<p>buy milk</p>")).toEqual({ title: "buy milk", body: "" });
  });

  test("a first block with NO text keeps the whole document", () => {
    // A lone pasted image is the realistic case. There is no title to lift, and
    // removing the block anyway would destroy the only thing the note holds.
    const html = '<figure><img src="x.png"></figure><p>from the whiteboard</p>';
    expect(splitTitleAndBody(html)).toEqual({ title: "", body: html });
  });

  test("collapses whitespace and caps a runaway first line", () => {
    const long = "x".repeat(400);
    const { title } = splitTitleAndBody(`<p>  spaced\n  out  </p><p>rest</p>`);
    expect(title).toBe("spaced out");
    expect(splitTitleAndBody(`<p>${long}</p>`).title).toHaveLength(120);
  });

  test("empty in, empty out — never a note titled 'undefined'", () => {
    expect(splitTitleAndBody("")).toEqual({ title: "", body: "" });
    expect(splitTitleAndBody("   ")).toEqual({ title: "", body: "" });
  });
});

describe("textToParagraphs", () => {
  test("one paragraph per line, so the first line stays the title", () => {
    expect(textToParagraphs("standup\nnotes")).toBe("<p>standup</p><p>notes</p>");
    // Round trip: what the box hands the editor is what the editor hands back.
    expect(splitTitleAndBody(textToParagraphs("standup\nnotes")).title).toBe("standup");
  });

  test("escapes what the user typed — markup is characters, not markup", () => {
    expect(textToParagraphs("<b>hi</b> & bye")).toBe("<p>&lt;b&gt;hi&lt;/b&gt; &amp; bye</p>");
  });

  test("a trailing newline is a caret, not content", () => {
    expect(textToParagraphs("one\n")).toBe("<p>one</p>");
    expect(textToParagraphs("")).toBe("");
    expect(textToParagraphs("\n  \n")).toBe("");
  });

  test("an interior blank line survives as a break", () => {
    expect(textToParagraphs("one\n\ntwo")).toBe("<p>one</p><p><br></p><p>two</p>");
  });
});

describe("hasRichContent", () => {
  test("prose and line breaks are what the plain box can already show", () => {
    expect(hasRichContent("<p>just words</p><p><br></p>")).toBe(false);
    expect(hasRichContent("")).toBe(false);
  });

  test("anything the box would flatten counts as rich", () => {
    // Collapsing the editor mirrors its TEXT back into the box, so these are
    // exactly the documents where the box is showing less than the whole
    // thought — and the pill has to say so rather than look identical.
    expect(hasRichContent("<h1>heading</h1>")).toBe(true);
    expect(hasRichContent("<ul><li><p>a</p></li></ul>")).toBe(true);
    expect(hasRichContent('<p>see <img src="x.png"></p>')).toBe(true);
    expect(hasRichContent("<p>a <strong>bold</strong> claim</p>")).toBe(true);
  });

  test("is not fooled by the letters p or br inside a longer tag name", () => {
    expect(hasRichContent("<pre>code</pre>")).toBe(true);
    expect(hasRichContent("<blockquote>quoted</blockquote>")).toBe(true);
  });
});
