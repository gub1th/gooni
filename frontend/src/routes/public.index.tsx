import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { fetchPublicNotes, fetchPublicProfile, fetchPublicVisitCount, updatePublicProfile, getStoredToken, patchNote, type PublicNote } from "../services/api";
import { Globe } from "lucide-react";
import { displayTitle } from "../utils/notePreview";
import { PublicChatLauncher } from "../components/PublicChatLauncher";
import { GooniMascot } from "../components/GooniMascot";

export const Route = createFileRoute("/public/")(({
  component: PublicPage,
}));

const FONT = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

function PenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0 }}>
      <path d="M9 2L11 4L4.5 10.5H2.5V8.5L9 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M6 2v3M10 2v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 5h8v3a4 4 0 0 1-4 4 4 4 0 0 1-4-4V5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
      <path d="M8 12v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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
  // Hover state for the per-row "remove from public" affordance — only the
  // owner ever sees the icon, anonymous visitors get the regular row.
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  // Undo state: when the owner unpublishes a note, we keep the row data
  // around so a one-click "Undo" within the toast window restores it.
  // null = no toast visible.
  const [undo, setUndo] = useState<{ note: PublicNote } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          "font-family: 'Inter', system-ui, sans-serif",
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

  function handleAddLink() {
    if (!bioEditor) return;
    const { from, to } = bioEditor.state.selection;
    const hasSelection = from !== to;
    const previousHref = bioEditor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previousHref ?? "https://");
    if (url === null) return;
    const trimmed = url.trim();
    if (trimmed === "") {
      bioEditor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (hasSelection) {
      bioEditor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    } else {
      // No selection — insert the URL as link text at the cursor.
      bioEditor.chain().focus().insertContent({
        type: "text",
        text: href,
        marks: [{ type: "link", attrs: { href } }],
      }).run();
    }
  }

  // ── Unpublish + undo flow ───────────────────────────────────────────
  // Owner clicks the per-row globe → optimistic remove from `notes`,
  // PATCH is_public=false to the backend, show a toast with an "Undo"
  // action for ~6s. Undo PATCHes is_public=true and re-inserts the row
  // at its original position.
  function handleUnpublish(note: PublicNote) {
    const idx = notes.findIndex((n) => n.id === note.id);
    setNotes((prev) => prev.filter((n) => n.id !== note.id));
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo({ note });
    patchNote(note.id, { is_public: false }).catch((e) => {
      // Revert on failure so the UI doesn't lie about server state.
      console.error("[public] unpublish failed", e);
      setNotes((prev) => {
        if (prev.some((n) => n.id === note.id)) return prev;
        const next = prev.slice();
        next.splice(Math.max(0, idx), 0, note);
        return next;
      });
      setUndo(null);
    });
    undoTimerRef.current = setTimeout(() => setUndo(null), 6000);
  }

  function handleUndoUnpublish() {
    if (!undo) return;
    const { note } = undo;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo(null);
    setNotes((prev) => {
      if (prev.some((n) => n.id === note.id)) return prev;
      // Re-insert sorted by updated_at desc — same order the API returns.
      const next = [...prev, note].sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });
      return next;
    });
    patchNote(note.id, { is_public: true }).catch((e) => {
      console.error("[public] undo unpublish failed", e);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
    });
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
            hi, my name is daniel
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
                fontSize: 13, color: "#666", textDecoration: "none",
                fontFamily: FONT,
                display: "inline-flex", alignItems: "center", gap: 5,
                borderBottom: "1px dashed rgba(0,0,0,0.20)",
                paddingBottom: 1,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#111")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#666")}
            >
              <PlugIcon /> mcp
            </Link>
          </div>
          {editing ? (
            <div style={{ margin: "14px 0 0" }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <button
                  onClick={handleAddLink}
                  title="Add or edit link"
                  style={{
                    padding: "3px 10px", borderRadius: 999,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "transparent", color: "#555",
                    fontSize: 12, fontFamily: FONT, cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 5,
                  }}
                >
                  🔗 Link
                </button>
              </div>
              <EditorContent editor={bioEditor} />
              <div style={{ fontSize: 11.5, color: "#999", marginTop: 6, fontFamily: FONT }}>
                Tip: select text → 🔗 Link, or paste a URL onto selected text.
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
                onMouseEnter={() => setHoveredId(note.id)}
                onMouseLeave={() => setHoveredId((cur) => (cur === note.id ? null : cur))}
                style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "13px 0", borderBottom: "1px solid rgba(0,0,0,0.07)" }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Link
                    to="/public/$noteId"
                    params={{ noteId: String(note.id) }}
                    style={{ fontSize: 17, fontWeight: 500, color: "#111", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = "underline")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = "none")}
                  >
                    {displayTitle({ title: note.title, content: note.excerpt })}
                  </Link>
                  <span style={{ fontSize: 13.5, color: "#999", marginTop: 3, display: "block" }}>
                    {formatDate(note.updated_at)} · {note.read_time_minutes} min read
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  {/* Owner-only: per-row globe → unpublish. Visible on hover
                      and (for keyboard users) when the row is focused. The
                      icon is also keyboard-reachable since it's a button. */}
                  {isOwner && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleUnpublish(note);
                      }}
                      title="Remove from public"
                      aria-label={`Remove "${displayTitle({ title: note.title, content: note.excerpt })}" from public`}
                      style={{
                        background: "transparent",
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 999,
                        width: 26, height: 26,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        color: "#444",
                        cursor: "pointer",
                        opacity: hoveredId === note.id ? 1 : 0,
                        transition: "opacity 0.15s ease, background 0.15s ease, color 0.15s ease",
                      }}
                      onMouseEnter={(e) => {
                        const el = e.currentTarget as HTMLButtonElement;
                        el.style.background = "rgba(220,38,38,0.08)";
                        el.style.color = "#B91C1C";
                      }}
                      onMouseLeave={(e) => {
                        const el = e.currentTarget as HTMLButtonElement;
                        el.style.background = "transparent";
                        el.style.color = "#444";
                      }}
                      onFocus={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
                    >
                      <Globe size={13} strokeWidth={1.8} />
                    </button>
                  )}
                  {note.space_name && (
                    <span style={{ fontSize: 12, color: "#666", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12, padding: "3px 9px" }}>
                      {note.space_name}
                    </span>
                  )}
                </div>
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

      {/* Undo toast for unpublish — bottom-center, owner-only. Auto-
          dismisses after 6s; the button restores the row + its
          public-state via patchNote. */}
      {undo && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 14,
            background: "#1C1C1E",
            color: "#FFF",
            padding: "10px 14px 10px 16px",
            borderRadius: 999,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            fontSize: 13.5,
            fontFamily: FONT,
            zIndex: 1300,
          }}
        >
          <span>Removed from public — "{displayTitle({ title: undo.note.title, content: undo.note.excerpt })}"</span>
          <button
            onClick={handleUndoUnpublish}
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.30)",
              color: "#FFF",
              borderRadius: 999,
              padding: "4px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >Undo</button>
        </div>
      )}
    </div>
  );
}
