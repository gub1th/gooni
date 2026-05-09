import { useEffect, useState } from "react";
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

export function NoteComments({ noteId }: NoteCommentsProps) {
  const [comments, setComments] = useState<ApiNoteComment[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const avatarUrl = useProfileStore((s) => s.avatarUrl);
  const fetchProfileOnce = useProfileStore((s) => s.fetchOnce);

  useEffect(() => { void fetchProfileOnce(); }, [fetchProfileOnce]);

  useEffect(() => {
    let cancelled = false;
    fetchNoteComments(noteId).then((rows) => {
      if (!cancelled) setComments(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  async function handleSubmit() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const c = await createNoteComment(noteId, body, "daniel");
      setComments((prev) => [...prev, c]);
      setDraft("");
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

  // Map an identity to the right avatar URL. Only "user"-kind authors
  // honour the uploaded avatar; claude + gooni keep their brand visuals.
  function avatarFor(identity: Identity, author: string): string | null {
    if (identity.kind !== "user") return null;
    if (author.trim().toLowerCase() === "daniel") return avatarUrl;
    return null;
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
        .gooni-comment-body code {
          background: rgba(15,23,42,0.06);
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 0.9em;
        }
        .gooni-comment-body pre {
          background: #0F172A;
          color: #F1F5F9;
          padding: 10px 12px;
          border-radius: 8px;
          margin: 8px 0;
          overflow-x: auto;
          font-size: 12.5px;
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
          return (
            <div
              key={c.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <CommentAvatar identity={identity} avatarUrl={avatarFor(identity, c.author)} size={36} />
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
                <div
                  className="gooni-comment-body"
                  style={{
                    fontSize: 14,
                    lineHeight: 1.55,
                    color: "#1E293B",
                    wordBreak: "break-word",
                  }}
                >
                  {renderMarkdown(c.content)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer — Confluence shape: avatar on the left, expanding card on
          the right with the textarea + an action row that surfaces only
          when there's a draft (or the field is focused). */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <CommentAvatar identity={myIdentity} avatarUrl={avatarUrl} size={36} />
        <div
          style={{
            flex: 1,
            background: "var(--gooni-card, #FFFFFF)",
            border: composerFocused || draft
              ? "1px solid rgba(15,23,42,0.20)"
              : "1px solid rgba(15,23,42,0.10)",
            borderRadius: 10,
            padding: "8px 12px 10px",
            transition: "border-color 0.15s, box-shadow 0.15s",
            boxShadow: composerFocused || draft
              ? "0 1px 3px rgba(15,23,42,0.06)"
              : "none",
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Add a comment… (markdown supported)"
            rows={composerFocused || draft ? 3 : 1}
            style={{
              width: "100%",
              resize: "none",
              padding: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontFamily: FONT,
              fontSize: 14,
              lineHeight: 1.55,
              color: "#1E293B",
              transition: "min-height 0.18s ease",
            }}
          />
          {(composerFocused || draft) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 8,
                gap: 8,
              }}
            >
              <span style={{ fontSize: 11, color: "#94A3B8" }}>⌘↵ to post · markdown ok</span>
              <div style={{ display: "flex", gap: 6 }}>
                {draft && (
                  <button
                    onClick={() => setDraft("")}
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
                  onClick={handleSubmit}
                  disabled={!draft.trim() || posting}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: !draft.trim() || posting ? "#CBD5E1" : "#0F172A",
                    color: "white",
                    fontFamily: FONT,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: !draft.trim() || posting ? "default" : "pointer",
                    transition: "background 0.12s",
                  }}
                >
                  {posting ? "Posting…" : "Comment"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
