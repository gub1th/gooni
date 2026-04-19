import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchPublicNotes, fetchPublicProfile, type PublicNote } from "../services/api";

export const Route = createFileRoute("/public/")(({
  component: PublicPage,
}));

const FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function PenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0 }}>
      <path d="M9 2L11 4L4.5 10.5H2.5V8.5L9 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M6.5 4V6.5L8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return `${Math.floor(diff / 30)}mo ago`;
}

function PublicPage() {
  const [notes, setNotes] = useState<PublicNote[]>([]);
  const [bio, setBio] = useState<string | null>(null);
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [lastActive, setLastActive] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    fetchPublicNotes().then(setNotes).catch(() => {});
    fetchPublicProfile().then((p) => {
      setBio(p.bio);
      setNoteCount(p.note_count);
      setLastActive(p.last_active);
    }).catch(() => {});
  }, []);

  const spaceNames = Array.from(
    new Set(notes.map((n) => n.space_name).filter((s): s is string => s !== null))
  );
  const displayed = filter ? notes.filter((n) => n.space_name === filter) : notes;

  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: FONT, color: "#111" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px 120px" }}>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.4px", marginBottom: 12 }}>
            daniel gunawan
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            {noteCount !== null && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#666" }}>
                <PenIcon />
                <span style={{ fontSize: 13 }}>
                  {noteCount} notes written
                  {notes.length > 0 && noteCount > notes.length && (
                    <span style={{ color: "#bbb", marginLeft: 5 }}>· {notes.length} public</span>
                  )}
                </span>
              </div>
            )}
            {lastActive && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#bbb" }}>
                <ClockIcon />
                <span style={{ fontSize: 13 }}>active {timeAgo(lastActive)}</span>
              </div>
            )}
          </div>
          {bio && (
            <p style={{ fontSize: 14.5, color: "#444", lineHeight: 1.7, margin: "14px 0 0", whiteSpace: "pre-wrap" }}>
              {bio}
            </p>
          )}
        </div>

        {/* Space filter bubbles */}
        {spaceNames.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 28, flexWrap: "wrap" }}>
            {spaceNames.map((name) => {
              const active = filter === name;
              return (
                <button
                  key={name}
                  onClick={() => setFilter(active ? null : name)}
                  style={{
                    padding: "4px 12px", borderRadius: 20, cursor: "pointer", fontFamily: FONT,
                    border: `1px solid ${active ? "#111" : "rgba(0,0,0,0.18)"}`,
                    background: active ? "#111" : "transparent",
                    color: active ? "#fff" : "#555",
                    fontSize: 12.5, transition: "background 0.15s, color 0.15s",
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}

        {/* Notes list */}
        {displayed.length === 0 ? (
          <p style={{ color: "#aaa", fontSize: 14 }}>No posts yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {displayed.map((note) => (
              <li
                key={note.id}
                style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "13px 0", borderBottom: "1px solid rgba(0,0,0,0.07)" }}
              >
                <div style={{ minWidth: 0 }}>
                  <Link
                    to="/public/$noteId"
                    params={{ noteId: String(note.id) }}
                    style={{ fontSize: 15, fontWeight: 500, color: "#111", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = "underline")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = "none")}
                  >
                    {note.title || "Untitled"}
                  </Link>
                  <span style={{ fontSize: 12.5, color: "#999", marginTop: 2, display: "block" }}>
                    {formatDate(note.updated_at)}
                  </span>
                </div>
                {note.space_name && (
                  <span style={{ flexShrink: 0, fontSize: 11.5, color: "#666", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12, padding: "2px 8px" }}>
                    {note.space_name}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
