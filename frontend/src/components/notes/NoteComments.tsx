import { useEffect, useState } from "react";
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

export function NoteComments({ noteId }: NoteCommentsProps) {
  const [comments, setComments] = useState<ApiNoteComment[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

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
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "#1E293B",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {c.content}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Add a comment..."
          rows={2}
          style={{
            flex: 1,
            resize: "vertical",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.10)",
            fontFamily: FONT,
            fontSize: 13,
            lineHeight: 1.5,
            outline: "none",
            background: "white",
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!draft.trim() || posting}
          style={{
            padding: "10px 16px",
            borderRadius: 10,
            border: "none",
            background: !draft.trim() || posting ? "#CBD5E1" : "#0F172A",
            color: "white",
            fontFamily: FONT,
            fontSize: 13,
            fontWeight: 500,
            cursor: !draft.trim() || posting ? "default" : "pointer",
          }}
        >
          {posting ? "..." : "Comment"}
        </button>
      </div>
    </div>
  );
}
