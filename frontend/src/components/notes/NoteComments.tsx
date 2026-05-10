import { useEffect, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  fetchNoteComments,
  createNoteComment,
  deleteNoteComment,
  type ApiNoteComment,
} from "../../services/api";
import { renderMarkdown } from "../../utils/markdown";
import { useProfileStore } from "../../stores/useProfileStore";
import { CommentAvatar, identityFor, type Identity } from "./CommentAvatar";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface NoteCommentsProps {
  noteId: number;
}

// Server stores naive UTC datetimes (datetime.utcnow). JS's Date constructor
// reads a naive ISO string as LOCAL time, which gave us the "10am instead
// of 3am" bug. Append "Z" when there's no timezone marker so it's parsed
// as UTC and rendered in the user's locale tz.
function parseServerIso(iso: string | null): Date | null {
  if (!iso) return null;
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function formatTime(iso: string | null): string {
  const d = parseServerIso(iso);
  if (!d) return "";
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

// MCP-authored comments arrive as full HTML (<h3>/<ul>/<strong>/<code>).
// User-authored comments arrive as the TipTap composer's HTML output too,
// since the composer round-trips through ProseMirror. Detect HTML by tag
// presence and render via dangerouslySetInnerHTML; fall back to the
// markdown renderer for legacy plain-text rows.
const HTML_TAG_RE = /<[a-z][^>]*>/i;

// Detect "empty editor" — TipTap leaves <p></p> on a blank instance, so
// `editor.isEmpty` lies after a clear/replace cycle. Strip tags and check
// for actual text content as the only honest emptiness signal.
function isHtmlEmpty(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").trim().length === 0;
}

export function NoteComments({ noteId }: NoteCommentsProps) {
  const [comments, setComments] = useState<ApiNoteComment[]>([]);
  const [posting, setPosting] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const avatarUrl = useProfileStore((s) => s.avatarUrl);
  const fetchProfileOnce = useProfileStore((s) => s.fetchOnce);

  useEffect(() => { void fetchProfileOnce(); }, [fetchProfileOnce]);

  // TipTap composer — same StarterKit baseline as the main NoteEditor so
  // formatting (markdown shortcuts: **bold**, ## heading, - list, etc)
  // feels consistent. No image extension here: comment threads stay
  // scannable. Cmd+Enter submits.
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: {
      attributes: {
        class: "gooni-comment-composer",
        style: [
          "font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          "font-size: 14px",
          "line-height: 1.55",
          "color: #1E293B",
          "outline: none",
          "min-height: 24px",
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
      const rows = await fetchNoteComments(noteId);
      setComments(rows);
    }
  }

  // Composer fixed to "daniel" — only authenticated identity. Avatar comes
  // from the profile store (uploaded image) and falls back to the goofy
  // emoji default in CommentAvatar.
  const myIdentity = identityFor("daniel");

  // Map an identity to the right avatar URL. Only owner-kind (Daniel)
  // honours the uploaded avatar; claude + gooni keep their brand visuals;
  // rando users get the auto-generated bot tile.
  function avatarFor(identity: Identity): string | null {
    if (identity.kind !== "owner") return null;
    return avatarUrl;
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
      <style>{`
        .gooni-comment-body p { margin: 0 0 8px; }
        .gooni-comment-body p:last-child { margin-bottom: 0; }
        .gooni-comment-body ul, .gooni-comment-body ol { margin: 4px 0 8px; padding-left: 20px; }
        .gooni-comment-body h2 { font-size: 16px; font-weight: 700; margin: 10px 0 6px; }
        .gooni-comment-body h3 { font-size: 14px; font-weight: 700; margin: 8px 0 4px; }
        .gooni-comment-body code {
          background: rgba(15,23,42,0.06);
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 0.9em;
          font-family: 'SF Mono', Menlo, monospace;
        }
        .gooni-comment-body pre {
          background: #0F172A;
          color: #F1F5F9;
          padding: 10px 12px;
          border-radius: 8px;
          margin: 8px 0;
          overflow-x: auto;
          font-size: 12.5px;
          font-family: 'SF Mono', Menlo, monospace;
        }
        .gooni-comment-body pre code { background: transparent; padding: 0; color: inherit; }
        .gooni-comment-body strong { font-weight: 600; }
        .gooni-comment-body em { font-style: italic; }
        .gooni-comment-body a { color: #2563EB; text-decoration: underline; }
        .gooni-comment-body blockquote {
          border-left: 3px solid rgba(15,23,42,0.20);
          padding-left: 10px;
          margin: 6px 0;
          color: #475569;
        }

        /* Composer mirrors the body styles but trimmed for inline use. */
        .gooni-comment-composer p { margin: 0 0 4px; }
        .gooni-comment-composer p:last-child { margin-bottom: 0; }
        .gooni-comment-composer ul, .gooni-comment-composer ol { margin: 4px 0; padding-left: 20px; }
        .gooni-comment-composer code {
          font-family: 'SF Mono', Menlo, monospace; font-size: 12.5px;
          background: rgba(15,23,42,0.06); padding: 1px 4px; border-radius: 3px;
        }
        .gooni-comment-composer pre {
          background: rgba(15,23,42,0.06); padding: 8px 10px; border-radius: 6px;
          font-family: 'SF Mono', Menlo, monospace; font-size: 12.5px;
          margin: 6px 0;
        }
        .gooni-comment-composer h2 { font-size: 16px; font-weight: 700; margin: 4px 0; }
        .gooni-comment-composer h3 { font-size: 14px; font-weight: 700; margin: 4px 0; }
      `}</style>

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
        <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 18 }}>
          No comments yet. Add the first one below — Claude can also drop comments here via MCP.
        </div>
      )}

      {/* Comment list — Confluence row layout: avatar on the left, header
          (name + timestamp) on top of body in the right column. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 22 }}>
        {comments.map((c) => {
          const identity = identityFor(c.author);
          const isHtml = HTML_TAG_RE.test(c.content);
          return (
            <div
              key={c.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <CommentAvatar identity={identity} avatarUrl={avatarFor(identity)} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: "#0F172A",
                    }}
                  >
                    {identity.display}
                  </span>
                  <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
                    {formatTime(c.created_at)}
                  </span>
                  <button
                    onClick={() => handleDelete(c.id)}
                    style={{
                      marginLeft: "auto",
                      border: "none",
                      background: "transparent",
                      color: "#CBD5E1",
                      fontSize: 13,
                      cursor: "pointer",
                      padding: "2px 6px",
                      borderRadius: 4,
                      transition: "color 0.12s, background 0.12s",
                    }}
                    title="Delete comment"
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color = "#EF4444";
                      (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.06)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.color = "#CBD5E1";
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    ×
                  </button>
                </div>
                {/* Two render paths: HTML-shaped content (TipTap composer
                    output + MCP add_comment HTML) goes through
                    dangerouslySetInnerHTML; legacy plain-text rows still
                    work via the markdown renderer. Trusted source: single-
                    user app, MCP auth-gated, no foreign authors. */}
                {isHtml ? (
                  <div
                    className="gooni-comment-body"
                    style={{
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: "#1E293B",
                      wordBreak: "break-word",
                    }}
                    dangerouslySetInnerHTML={{ __html: c.content }}
                  />
                ) : (
                  <div
                    className="gooni-comment-body"
                    style={{
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: "#1E293B",
                      wordBreak: "break-word",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {renderMarkdown(c.content)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer — Confluence shape: avatar on the left, TipTap editor
          card on the right with a Cmd+Enter helper line + Comment button. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <CommentAvatar identity={myIdentity} avatarUrl={avatarUrl} size={36} />
        <div
          style={{
            flex: 1,
            background: "var(--gooni-card, #FFFFFF)",
            border: hasContent
              ? "1px solid rgba(15,23,42,0.20)"
              : "1px solid rgba(15,23,42,0.10)",
            borderRadius: 10,
            padding: "10px 14px 10px",
            transition: "border-color 0.15s, box-shadow 0.15s",
            boxShadow: hasContent ? "0 1px 3px rgba(15,23,42,0.06)" : "none",
          }}
        >
          <EditorContent editor={editor} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 10,
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, color: "#94A3B8" }}>
              ⌘↵ to post
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              {hasContent && (
                <button
                  onClick={() => {
                    editor?.commands.clearContent();
                    setHasContent(false);
                  }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: "none",
                    background: "transparent",
                    color: "#64748B",
                    fontFamily: FONT,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={submitFromEditor}
                disabled={!hasContent || posting}
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  border: "none",
                  background: !hasContent || posting ? "#CBD5E1" : "#0F172A",
                  color: "white",
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: !hasContent || posting ? "default" : "pointer",
                  transition: "background 0.12s",
                }}
              >
                {posting ? "Posting…" : "Comment"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
