import { Fragment, type ReactNode } from "react";

// Tiny inline-only markdown renderer. Handles **bold**, *italic*, `code`,
// [text](url), and preserves newlines. Block-level constructs (lists,
// headings, code fences) are intentionally NOT supported — chat replies
// shouldn't be using them, and ignoring them keeps the parser predictable.
//
// Why DIY: avoid pulling in react-markdown for what's essentially a 50-line
// regex pass. If we ever need real markdown (tables, GFM, etc) we can swap
// this out without touching call sites.
//
// Order of substitution matters: code first (so its contents aren't
// re-interpreted), then links, then bold, then italic. Tokens use a
// non-text array shape so we don't have to deal with HTML escaping.

type Token =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; text: string; href: string }
  | { type: "bold"; children: Token[] }
  | { type: "italic"; children: Token[] };

function tokenizeInline(input: string): Token[] {
  // Pass 1: pull out `code` spans (non-greedy, single-line). Backtick-quoted
  // content is treated literally and won't be processed further.
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const tickStart = input.indexOf("`", i);
    if (tickStart === -1) {
      out.push(...tokenizeNoCode(input.slice(i)));
      break;
    }
    if (tickStart > i) {
      out.push(...tokenizeNoCode(input.slice(i, tickStart)));
    }
    const tickEnd = input.indexOf("`", tickStart + 1);
    if (tickEnd === -1) {
      // unmatched backtick — treat as literal
      out.push({ type: "text", value: input.slice(tickStart) });
      break;
    }
    out.push({ type: "code", value: input.slice(tickStart + 1, tickEnd) });
    i = tickEnd + 1;
  }
  return out;
}

function tokenizeNoCode(input: string): Token[] {
  const out: Token[] = [];
  let rest = input;

  while (rest.length > 0) {
    // Link: [text](url)
    const linkMatch = rest.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
    // Bold: **text**
    const boldMatch = rest.match(/\*\*([^*]+?)\*\*/);
    // Italic: *text* or _text_ (avoid matching inside words: *foo* but not 2*3)
    const italicMatch = rest.match(/(^|[\s.,!?(])\*([^*\s][^*]*?)\*(?=[\s.,!?)]|$)/);
    const underMatch = rest.match(/(^|[\s.,!?(])_([^_\s][^_]*?)_(?=[\s.,!?)]|$)/);

    const candidates: Array<{ idx: number; len: number; node: Token; offset: number }> = [];
    if (linkMatch && linkMatch.index !== undefined) {
      candidates.push({
        idx: linkMatch.index,
        len: linkMatch[0].length,
        node: { type: "link", text: linkMatch[1], href: linkMatch[2] },
        offset: 0,
      });
    }
    if (boldMatch && boldMatch.index !== undefined) {
      candidates.push({
        idx: boldMatch.index,
        len: boldMatch[0].length,
        node: { type: "bold", children: tokenizeInline(boldMatch[1]) },
        offset: 0,
      });
    }
    if (italicMatch && italicMatch.index !== undefined) {
      const lead = italicMatch[1] || "";
      candidates.push({
        idx: italicMatch.index + lead.length,
        len: italicMatch[0].length - lead.length,
        node: { type: "italic", children: tokenizeInline(italicMatch[2]) },
        offset: italicMatch.index,
      });
    }
    if (underMatch && underMatch.index !== undefined) {
      const lead = underMatch[1] || "";
      candidates.push({
        idx: underMatch.index + lead.length,
        len: underMatch[0].length - lead.length,
        node: { type: "italic", children: tokenizeInline(underMatch[2]) },
        offset: underMatch.index,
      });
    }
    if (candidates.length === 0) {
      out.push({ type: "text", value: rest });
      break;
    }
    // Pick earliest match.
    candidates.sort((a, b) => a.idx - b.idx);
    const pick = candidates[0];
    if (pick.idx > 0) {
      out.push({ type: "text", value: rest.slice(0, pick.idx) });
    }
    out.push(pick.node);
    rest = rest.slice(pick.idx + pick.len);
  }

  return out;
}

function renderTokens(tokens: Token[], keyPrefix = ""): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${keyPrefix}${i}`;
    if (t.type === "text") return <Fragment key={k}>{t.value}</Fragment>;
    if (t.type === "code") {
      return (
        <code
          key={k}
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: "0.92em",
            padding: "1px 5px",
            borderRadius: 4,
            background: "rgba(0,0,0,0.06)",
          }}
        >
          {t.value}
        </code>
      );
    }
    if (t.type === "link") {
      return (
        <a
          key={k}
          href={t.href}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: "#2563EB", textDecoration: "underline" }}
        >
          {t.text}
        </a>
      );
    }
    if (t.type === "bold") {
      return (
        <strong key={k} style={{ fontWeight: 600 }}>
          {renderTokens(t.children, `${k}.`)}
        </strong>
      );
    }
    if (t.type === "italic") {
      return (
        <em key={k} style={{ fontStyle: "italic" }}>
          {renderTokens(t.children, `${k}.`)}
        </em>
      );
    }
    return null;
  });
}

export function renderMarkdown(text: string): ReactNode {
  if (!text) return null;
  // Preserve newlines via the parent's white-space: pre-wrap. We don't need
  // <br/> here — the surrounding container is already styled for it.
  return <>{renderTokens(tokenizeInline(text))}</>;
}
