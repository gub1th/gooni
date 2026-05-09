import { useEffect, useState } from "react";
import {
  fetchNoteComments,
  createNoteComment,
  deleteNoteComment,
  type ApiNoteComment,
} from "../../services/api";
import { GooniLogo } from "../GooniLogo";

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

// Map a free-text author label to a normalized identity. Display name +
// avatar visual are derived from this. "claude"/"claude code"/"claude-code"
// all collapse to the Claude Code identity; "gooni" maps to the mascot;
// everything else falls through to the per-name gradient avatar.
type Identity =
  | { kind: "claude"; display: string }
  | { kind: "gooni"; display: string }
  | { kind: "user"; display: string };

function identityFor(rawAuthor: string): Identity {
  const a = (rawAuthor || "").trim().toLowerCase();
  if (a === "claude" || a === "claude code" || a === "claude-code" || a === "claudecode") {
    return { kind: "claude", display: "Claude Code" };
  }
  if (a === "gooni") {
    return { kind: "gooni", display: "Gooni" };
  }
  // Capitalize first letter for display ("daniel" → "Daniel"). Multi-word
  // labels are left as-typed.
  const display = rawAuthor
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return { kind: "user", display: display || "Anonymous" };
}

// Deterministic gradient pair from a name. Two complementary HSL hues
// derived from the string hash so the same name always renders the same
// avatar across reloads / surfaces. Used for "user"-kind identities only —
// Claude + Gooni get fixed brand visuals.
function gradientFor(name: string): { from: string; to: string; ring: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  const altHue = (hue + 38) % 360;
  return {
    from: `hsl(${hue} 70% 56%)`,
    to: `hsl(${altHue} 72% 44%)`,
    ring: `hsl(${hue} 70% 56% / 0.18)`,
  };
}

// Anthropic-style "burst" mark for Claude. Rendered on a warm-orange disc
// so it reads as the Claude brand even when shrunk to comment-avatar size.
function ClaudeMark({ size = 36 }: { size?: number }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: "linear-gradient(135deg, #FFB78A 0%, #D97757 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 1px 3px rgba(217,119,87,0.30), inset 0 0 0 1px rgba(255,255,255,0.18)",
        flex: "none",
      }}
      aria-label="Claude Code"
    >
      <svg width={Math.round(size * 0.55)} height={Math.round(size * 0.55)} viewBox="0 0 24 24" fill="none">
        {/* Stylized 4-point burst — evokes the Anthropic glyph without copying it pixel-for-pixel. */}
        <path
          d="M12 2 C12 7 13 9 18 10.5 C13 12 12 13.5 12 22 C12 13.5 11 12 6 10.5 C11 9 12 7 12 2 Z"
          fill="#FFFFFF"
        />
      </svg>
    </div>
  );
}

function InitialAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const grad = gradientFor(name.toLowerCase());
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: `linear-gradient(135deg, ${grad.from} 0%, ${grad.to} 100%)`,
        color: "#FFFFFF",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.round(size * 0.42), fontWeight: 600,
        fontFamily: FONT, letterSpacing: 0.2,
        boxShadow: `0 1px 3px ${grad.ring}, inset 0 0 0 1px rgba(255,255,255,0.16)`,
        flex: "none",
      }}
      aria-label={name}
    >
      {initial}
    </div>
  );
}

function Avatar({ identity, size = 36 }: { identity: Identity; size?: number }) {
  if (identity.kind === "claude") return <ClaudeMark size={size} />;
  if (identity.kind === "gooni") {
    return (
      <div style={{
        width: size, height: size, borderRadius: "50%",
        overflow: "hidden",
        background: "#0F0F0F",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 1px 3px rgba(15,15,15,0.30)",
        flex: "none",
      }}>
        <GooniLogo size={Math.round(size * 0.92)} />
      </div>
    );
  }
  return <InitialAvatar name={identity.display} size={size} />;
}

export function NoteComments({ noteId }: NoteCommentsProps) {
  const [comments, setComments] = useState<ApiNoteComment[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);

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

  // Composer identity is fixed to "daniel" (the only authenticated user) so
  // the avatar in the composer row matches what'll show after submit.
  const myIdentity = identityFor("daniel");

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
              <Avatar identity={identity} size={36} />
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
                  style={{
                    fontSize: 14,
                    lineHeight: 1.55,
                    color: "#1E293B",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {c.content}
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
        <Avatar identity={myIdentity} size={36} />
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
            placeholder="Add a comment…"
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
              <span style={{ fontSize: 11, color: "#94A3B8" }}>⌘↵ to post</span>
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
