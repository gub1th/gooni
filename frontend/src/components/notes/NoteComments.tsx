import { useEffect, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  fetchNoteComments,
  createNoteComment,
  deleteNoteComment,
  type ApiNoteComment,
} from "../../services/api";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface NoteCommentsProps {
  noteId: number;
}

// Render a comment body for innerHTML. If the content already contains an
// HTML tag (MCP-authored comments use h3/ul/strong/code/etc), pass through
// untouched. If it's plain text from the textarea composer, escape special
// chars and convert newlines to <br> so user-typed line breaks survive.
const HTML_TAG_RE = /<[a-z][^>]*>/i;
function renderCommentHtml(raw: string): string {
  if (HTML_TAG_RE.test(raw)) return raw;
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped.replace(/\n/g, "<br>");
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function authorAccent(author: string): string {
  const a = author.toLowerCase();
  if (a === "claude") return "#A855F7";
  if (a === "gooni") return "#10B981";
  return "#475569";
}

// Detect "empty editor" — TipTap's `<p></p>` round-trip leaves an empty
// paragraph; only treat the editor as having content when there's actual
// text after stripping tags.
function isHtmlEmpty(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").trim().length === 0;
}

export function NoteComments({ noteId }: NoteCommentsProps) {
  const [comments, setComments] = useState<ApiNoteComment[]>([]);
  const [posting, setPosting] = useState(false);
  const [hasContent, setHasContent] = useState(false);

  // TipTap composer — same StarterKit baseline as the main NoteEditor so
  // formatting (bold/italic/lists/code/headings via slash menu) feels
  // consistent. No image extension here: comment threads stay scannable.
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: {
      attributes: {
        class: "gooni-comment-composer",
        style: [
          "font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          "font-size: 13px",
          "line-height: 1.5",
          "color: #1E293B",
          "outline: none",
          "min-height: 60px",
          "padding: 10px 12px",
        ].join("; "),
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submitFromEditor();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      setHasContent(!isHtmlEmpty(editor.getHTML()));
    },
  }, [noteId]);

  useEffect(() => {
    let cancelled = false;
    fetchNoteComments(noteId).then((rows) => {
      if (!cancelled) setComments(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  async function submitFromEditor() {
    if (!editor || posting) return;
    const html = editor.getHTML();
    if (isHtmlEmpty(html)) return;
    setPosting(true);
    try {
      const c = await createNoteComment(noteId, html, "daniel");
      setComments((prev) => [...prev, c]);
      editor.commands.clearContent();
      setHasContent(false);
    } finally {
      setPosting(false);
    }
  }

  async function handleDelete(id: number) {
    setComments((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteNoteComment(id);
    } catch {
      // re-fetch on failure so optimistic delete doesn't lie
      const rows = await fetchNoteComments(noteId);
      setComments(rows);
    }
  }

  return (
    <div
      style={{
        marginTop: 32,
        padding: "20px 0 8px",
        borderTop: "1px solid rgba(0,0,0,0.08)",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.4,
          color: "#64748B",
          textTransform: "uppercase",
          marginBottom: 14,
        }}
      >
        Comments {comments.length > 0 ? `(${comments.length})` : ""}
      </div>

      {comments.length === 0 && (
        <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 14 }}>
          No comments yet. Add the first one below — Claude can also drop comments here via MCP.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
        {comments.map((c) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(241,245,249,0.55)",
              border: "1px solid rgba(0,0,0,0.05)",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                flex: "none",
                background: authorAccent(c.author),
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
              }}
              title={c.author}
            >
              {c.author.slice(0, 1)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#0F172A",
                  }}
                >
                  {c.author}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "#94A3B8" }}>
                    {formatTime(c.created_at)}
                  </span>
                  <button
                    onClick={() => handleDelete(c.id)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#94A3B8",
                      fontSize: 11,
                      cursor: "pointer",
                      padding: "2px 4px",
                    }}
                    title="Delete comment"
                  >
                    ×
                  </button>
                </div>
              </div>
              {/* Comment bodies arrive as plain text or short HTML
                  (MCP add_comment + the editor textarea both write raw
                  strings). Render via dangerouslySetInnerHTML so HTML
                  tags from MCP-authored comments (h3 / ul / strong /
                  code) become real elements. Trusted source: single-user
                  app, MCP auth-gated, no foreign authors. Plain-text
                  comments still render correctly because raw text
                  without tags is just text — newlines collapse though,
                  so user-typed multi-line comments need <br> via the
                  composer (textarea -> innerHTML helper below). */}
              <div
                className="gooni-note-comment-body"
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "#1E293B",
                  wordBreak: "break-word",
                }}
                dangerouslySetInnerHTML={{ __html: renderCommentHtml(c.content) }}
              />
            </div>
          </div>
        ))}
      </div>

      <style>{`
        .gooni-comment-composer p { margin: 0 0 4px; }
        .gooni-comment-composer p:last-child { margin-bottom: 0; }
        .gooni-comment-composer ul, .gooni-comment-composer ol { margin: 4px 0; padding-left: 20px; }
        .gooni-comment-composer code {
          font-family: 'SF Mono', Menlo, monospace; font-size: 12px;
          background: rgba(15,23,42,0.06); padding: 1px 4px; border-radius: 3px;
        }
        .gooni-comment-composer pre {
          background: rgba(15,23,42,0.06); padding: 8px 10px; border-radius: 6px;
          font-family: 'SF Mono', Menlo, monospace; font-size: 12px;
          margin: 6px 0;
        }
      `}</style>
      <div
        style={{
          fontSize: 11,
          color: "#94A3B8",
          marginBottom: 6,
        }}
      >
        Add a comment — markdown shortcuts (**bold**, ## heading, - list) work. Cmd+Enter to send.
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "stretch",
          border: "1px solid rgba(0,0,0,0.10)",
          borderRadius: 10,
          background: "white",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <EditorContent editor={editor} />
        </div>
        <button
          onClick={submitFromEditor}
          disabled={!hasContent || posting}
          style={{
            margin: 6,
            padding: "0 16px",
            borderRadius: 8,
            border: "none",
            background: !hasContent || posting ? "#CBD5E1" : "#0F172A",
            color: "white",
            fontFamily: FONT,
            fontSize: 13,
            fontWeight: 500,
            cursor: !hasContent || posting ? "default" : "pointer",
            alignSelf: "flex-end",
            height: 36,
          }}
        >
          {posting ? "..." : "Comment"}
        </button>
      </div>
    </div>
  );
}
