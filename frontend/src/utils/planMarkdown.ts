// Convert PLAN_MODE_PROMPT-shaped markdown into TipTap-friendly HTML.
// Plans only use a small subset: `## headers`, paragraphs, blank lines.
// We don't pull in a full markdown library because:
//   1. The corpus is bounded by the prompt — no nested formatting expected.
//   2. We want the round-trip to stay clean: TipTap parses the output as
//      paragraphs + headings, no <code>/<table>/<ul> surprises.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function planMarkdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] = [];

  function flushPara() {
    if (buf.length === 0) return;
    const text = escapeHtml(buf.join(" ")).trim();
    if (text) out.push(`<p>${text}</p>`);
    buf = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushPara();
      out.push(`<h2>${escapeHtml(h2[1])}</h2>`);
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushPara();
      out.push(`<h3>${escapeHtml(h3[1])}</h3>`);
      continue;
    }
    buf.push(line);
  }
  flushPara();
  return out.join("\n");
}

// Option chip parser. The PLAN_MODE_PROMPT instructs Gooni to drop
// `[ ] option text` lines into the message. We pull those out so the
// chip renderer can show them as buttons; the remaining text renders
// as normal markdown.
const OPTION_RE = /^\[\s*\]\s+(.+)$/;

export function extractOptions(text: string): { body: string; options: string[] } {
  const lines = text.split(/\r?\n/);
  const options: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const m = line.match(OPTION_RE);
    if (m) {
      const opt = m[1].trim();
      if (opt) options.push(opt);
    } else {
      body.push(line);
    }
  }
  return { body: body.join("\n").trim(), options };
}

// `<plan>...</plan>` finalize block detector.
const PLAN_RE = /<plan>([\s\S]*?)<\/plan>/i;

export function extractPlanBlock(text: string): { before: string; plan: string | null; after: string } {
  const m = text.match(PLAN_RE);
  if (!m || m.index == null) return { before: text, plan: null, after: "" };
  return {
    before: text.slice(0, m.index).trim(),
    plan: m[1].trim(),
    after: text.slice(m.index + m[0].length).trim(),
  };
}
