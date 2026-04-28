import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { fetchPublicNotes, fetchPublicProfile, fetchPublicVisitCount, updatePublicProfile, getStoredToken, type PublicNote } from "../services/api";
import { PublicChatLauncher } from "../components/PublicChatLauncher";
import { GooniMascot } from "../components/GooniMascot";

export const Route = createFileRoute("/public/")(({
  component: PublicPage,
}));

const FONT = "'Manrope', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

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
  const [visitors, setVisitors] = useState<number | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  const isOwner = getStoredToken() !== null;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const bioEditor = useEditor({
    extensions: [
      StarterKit,
      LinkExtension.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        style: [
          "font-family: 'Manrope', system-ui, sans-serif",
          "font-size: 15.5px",
          "line-height: 1.7",
          "color: #444",
          "outline: none",
          "min-height: 80px",
          "padding: 10px 14px",
          "border: 1px solid rgba(0,0,0,0.12)",
          "border-radius: 10px",
        ].join("; "),
      },
    },
  });

  useEffect(() => {
    fetchPublicNotes().then(setNotes).catch(() => {});
    fetchPublicProfile().then((p) => {
      setBio(p.bio);
      setNoteCount(p.note_count);
      setLastActive(p.last_active);
    }).catch(() => {});
    fetchPublicVisitCount().then((v) => setVisitors(v.unique_visitors)).catch(() => {});
  }, []);

  async function handleSaveBio() {
    if (!bioEditor) return;
    const html = bioEditor.isEmpty ? "" : bioEditor.getHTML();
    setSaving(true);
    try {
      await updatePublicProfile(html);
      setBio(html);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function handleStartEdit() {
    bioEditor?.commands.setContent(bio ?? "");
    setEditing(true);
    setTimeout(() => bioEditor?.commands.focus("end"), 0);
  }

  // Treat legacy plain-text bios as text; new HTML bios render rich.
  const bioIsHtml = bio !== null && /<[a-z][\s\S]*>/i.test(bio);

  // Invisible viewport bounds for the mascot to walk in (matches GooniLayer).
  const mascotBoundsRef = useRef<HTMLDivElement>(null);

  const spaceNames = Array.from(
    new Set(notes.map((n) => n.space_name).filter((s): s is string => s !== null))
  );
  const displayed = filter ? notes.filter((n) => n.space_name === filter) : notes;

  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: FONT, color: "#111" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px 120px" }}>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 14 }}>
            daniel gunawan
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            {noteCount !== null && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#666" }}>
                <PenIcon />
                <span style={{ fontSize: 14 }}>
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
                <span style={{ fontSize: 14 }}>active {timeAgo(lastActive)}</span>
              </div>
            )}
            {visitors !== null && visitors > 0 && (
              <span style={{ fontSize: 13, color: "#cfcfcf", fontVariantNumeric: "tabular-nums" }}>
                {visitors.toLocaleString()} unique {visitors === 1 ? "visitor" : "visitors"}
              </span>
            )}
            <Link
              to="/public/mcp"
              style={{
                fontSize: 12, color: "#666", textDecoration: "none",
                border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12,
                padding: "3px 10px", fontFamily: FONT,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = "rgba(0,0,0,0.04)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = "transparent")}
            >
              MCP
            </Link>
          </div>
          {editing ? (
            <div style={{ margin: "14px 0 0" }}>
              <EditorContent editor={bioEditor} />
              <div style={{ fontSize: 11.5, color: "#999", marginTop: 6, fontFamily: FONT }}>
                Tip: select text, paste a URL to make it a link.
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <button
                  onClick={handleSaveBio}
                  disabled={saving}
                  style={{
                    padding: "6px 14px", borderRadius: 8, border: "none",
                    background: "#111", color: "#fff", fontSize: 12.5,
                    fontFamily: FONT, cursor: "pointer", fontWeight: 500,
                  }}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  style={{
                    padding: "6px 14px", borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "transparent", color: "#555", fontSize: 12.5,
                    fontFamily: FONT, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, margin: "14px 0 0" }}>
              {bio ? (
                bioIsHtml ? (
                  <div
                    className="gooni-public-bio"
                    style={{ fontSize: 15.5, color: "#444", lineHeight: 1.7, flex: 1 }}
                    dangerouslySetInnerHTML={{ __html: bio }}
                  />
                ) : (
                  <p style={{ fontSize: 15.5, color: "#444", lineHeight: 1.7, margin: 0, whiteSpace: "pre-wrap", flex: 1 }}>
                    {bio}
                  </p>
                )
              ) : isOwner ? (
                <p style={{ fontSize: 15, color: "#bbb", fontStyle: "italic", margin: 0, flex: 1 }}>
                  No bio yet.
                </p>
              ) : null}
              {isOwner && (
                <button
                  onClick={handleStartEdit}
                  title="Edit bio"
                  style={{
                    flexShrink: 0, padding: "3px 10px", borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.12)", background: "transparent",
                    color: "#555", fontSize: 12, cursor: "pointer", fontFamily: FONT,
                  }}
                >
                  Edit
                </button>
              )}
            </div>
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
                    style={{ fontSize: 17, fontWeight: 500, color: "#111", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = "underline")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = "none")}
                  >
                    {note.title || "Untitled"}
                  </Link>
                  <span style={{ fontSize: 13.5, color: "#999", marginTop: 3, display: "block" }}>
                    {formatDate(note.updated_at)} · {note.read_time_minutes} min read
                  </span>
                </div>
                {note.space_name && (
                  <span style={{ flexShrink: 0, fontSize: 12, color: "#666", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12, padding: "3px 9px" }}>
                    {note.space_name}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        ref={mascotBoundsRef}
        aria-hidden
        style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 1 }}
      />
      <GooniMascot dashboardRef={mascotBoundsRef} />
      <PublicChatLauncher />
    </div>
  );
}
