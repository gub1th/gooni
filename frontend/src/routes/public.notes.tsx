import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import { updatePublicProfile, getStoredToken, patchNote, type PublicNote } from "../services/api";
import { Globe, Pin, PinOff } from "lucide-react";
import { displayTitle } from "../utils/notePreview";
import { Skeleton } from "../components/Skeleton";
import { color as ctok, FONT, z } from "../ui";
import { formatLongDate as formatDate, parseServerDate } from "../utils/date";
import {
  publicNoteQueryOptions,
  publicNotesListQueryOptions,
  publicProfileQueryOptions,
  publicVisitCountQueryOptions,
} from "../utils/publicQueries";

export const Route = createFileRoute("/public/notes")(({
  component: PublicPage,
}));

// Display serif for the name + hero titles. System serifs only — no webfont
// network cost. "Iowan Old Style" + "Hoefler Text" are macOS-native and
// genuinely beautiful at display size; Georgia is a clean fallback elsewhere.
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

function PlazaCta() {
  const shimRef = useRef<HTMLSpanElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  return (
    <Link
      to="/public"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 14,
        padding: "16px 24px",
        borderRadius: 18,
        background: "var(--gooni-card, #ffffff)",
        border: "1.5px solid #9FE1CB",
        color: "#085041",
        textDecoration: "none",
        fontFamily: FONT,
        transition: "all 0.25s ease",
        cursor: "pointer",
        position: "relative",
        overflow: "hidden",
        maxWidth: 340,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = "#1D9E75";
        el.style.transform = "translateY(-2px)";
        if (arrowRef.current) arrowRef.current.style.transform = "translateX(6px)";
        if (shimRef.current) shimRef.current.style.transform = "translateX(400px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = "#9FE1CB";
        el.style.transform = "translateY(0)";
        if (arrowRef.current) arrowRef.current.style.transform = "translateX(0)";
        if (shimRef.current) shimRef.current.style.transform = "translateX(-100px)";
      }}
    >
      <span
        ref={shimRef}
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 60,
          height: "100%",
          background: "linear-gradient(90deg, transparent, rgba(29,158,117,0.06), transparent)",
          transform: "translateX(-100px)",
          transition: "transform 0.6s ease",
          pointerEvents: "none",
        }}
      />
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          background: "#E1F5EE",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <WalkingGooni />
      </span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: "#085041" }}>Wander the plaza</span>
        <span style={{ fontSize: 12, color: "#0F6E56", opacity: 0.6, marginTop: 1 }}>explore in 3D</span>
      </span>
      <span
        ref={arrowRef}
        aria-hidden
        style={{ color: "#1D9E75", transition: "transform 0.25s", fontSize: 18 }}
      >
        →
      </span>
    </Link>
  );
}

function WalkingGooni() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <g style={{ animation: "plazaCtaWalkBob 0.5s ease-in-out infinite" }}>
        <circle cx="15" cy="8" r="5" fill="#F5F5F0" />
        <circle cx="14" cy="7.5" r="1" fill="#1a1a1a" />
        <circle cx="14.3" cy="7.2" r="0.3" fill="#fff" />
        <path d="M13 9.5 Q14.5 10.8 15.5 9.8" stroke="#1a1a1a" strokeWidth="0.5" fill="none" />
        <rect x="12" y="13" width="6" height="6" rx="2" fill="#4ADE80" />
        <rect
          x="10.5" y="14.5" width="2" height="1.2" rx="0.6" fill="#4ADE80"
          style={{ animation: "plazaCtaArmBack 0.5s ease-in-out infinite", transformOrigin: "12.5px 14.5px" }}
        />
        <rect
          x="17.5" y="14.5" width="2" height="1.2" rx="0.6" fill="#4ADE80"
          style={{ animation: "plazaCtaArmFront 0.5s ease-in-out infinite", transformOrigin: "17.5px 14.5px" }}
        />
        <rect
          x="12.5" y="19" width="1.8" height="3" rx="0.7" fill="#3AAD6E"
          style={{ animation: "plazaCtaLegFront 0.5s ease-in-out infinite", transformOrigin: "13.4px 19px" }}
        />
        <rect
          x="15.5" y="19" width="1.8" height="3" rx="0.7" fill="#3AAD6E"
          style={{ animation: "plazaCtaLegBack 0.5s ease-in-out infinite", transformOrigin: "16.4px 19px" }}
        />
      </g>
      <style>{`
        @keyframes plazaCtaWalkBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-1.5px); }
        }
        @keyframes plazaCtaLegFront {
          0%, 100% { transform: rotate(-15deg); }
          50% { transform: rotate(15deg); }
        }
        @keyframes plazaCtaLegBack {
          0%, 100% { transform: rotate(15deg); }
          50% { transform: rotate(-15deg); }
        }
        @keyframes plazaCtaArmFront {
          0%, 100% { transform: rotate(10deg); }
          50% { transform: rotate(-10deg); }
        }
        @keyframes plazaCtaArmBack {
          0%, 100% { transform: rotate(-10deg); }
          50% { transform: rotate(10deg); }
        }
      `}</style>
    </svg>
  );
}

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

function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M8 1.6 L9.1 6.2 L13.7 7.3 L9.1 8.4 L8 13 L6.9 8.4 L2.3 7.3 L6.9 6.2 Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function timeAgo(iso: string | null): string {
  const d = parseServerDate(iso);
  if (!d) return "";
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return `${Math.floor(diff / 30)}mo ago`;
}

function PublicPage() {
  const queryClient = useQueryClient();
  // List + profile + visits via React Query so back-navigation hits cache
  // (default staleTime in main.tsx is 30s; gcTime 5min) instead of refetching.
  const { data: notesData } = useQuery(publicNotesListQueryOptions());
  const { data: profileData } = useQuery(publicProfileQueryOptions());
  const { data: visitsData } = useQuery(publicVisitCountQueryOptions());

  // Local override of the list — needed for optimistic unpublish + undo,
  // since we want the row to disappear immediately without waiting for a
  // refetch round-trip. null = use the React Query result as-is.
  const [localNotes, setLocalNotes] = useState<PublicNote[] | null>(null);
  const notes = localNotes ?? notesData ?? [];
  const bio = profileData?.bio ?? null;
  const noteCount = profileData?.note_count ?? null;
  const lastActive = profileData?.last_active ?? null;
  const visitors = visitsData?.unique_visitors ?? null;

  // Initial-fetch flags. Skeletons render until data lands. Optimistic
  // edits set `localNotes`, so we treat any non-null local list as
  // "loaded" — otherwise unpublishing the only note would flash the
  // skeletons back on.
  const profileLoading = profileData === undefined;
  const notesLoading = notesData === undefined && localNotes === null;

  const isOwner = getStoredToken() !== null;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
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


  async function handleSaveBio() {
    if (!bioEditor) return;
    const html = bioEditor.isEmpty ? "" : bioEditor.getHTML();
    setSaving(true);
    try {
      await updatePublicProfile(html);
      // Patch the cached profile in place so the bio updates without a refetch.
      queryClient.setQueryData(publicProfileQueryOptions().queryKey, (prev) => {
        if (!prev) return prev;
        return { ...prev, bio: html };
      });
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
    const optimistic = notes.filter((n) => n.id !== note.id);
    setLocalNotes(optimistic);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo({ note });
    patchNote(note.id, { is_public: false })
      .then(() => {
        // Sync the React Query cache so leaving + returning shows the same list.
        queryClient.setQueryData(publicNotesListQueryOptions().queryKey, optimistic);
        setLocalNotes(null);
      })
      .catch((e) => {
        // Revert on failure so the UI doesn't lie about server state.
        console.error("[public] unpublish failed", e);
        setLocalNotes((prev) => {
          const base = prev ?? notesData ?? [];
          if (base.some((n) => n.id === note.id)) return base;
          const next = base.slice();
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
    const restored = (() => {
      const base = notes;
      if (base.some((n) => n.id === note.id)) return base;
      return [...base, note].sort((a, b) => {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });
    })();
    setLocalNotes(restored);
    patchNote(note.id, { is_public: true })
      .then(() => {
        queryClient.setQueryData(publicNotesListQueryOptions().queryKey, restored);
        setLocalNotes(null);
      })
      .catch((e) => {
        console.error("[public] undo unpublish failed", e);
        setLocalNotes((prev) => (prev ?? notesData ?? []).filter((n) => n.id !== note.id));
      });
  }

  // Treat legacy plain-text bios as text; new HTML bios render rich.
  const bioIsHtml = bio !== null && /<[a-z][\s\S]*>/i.test(bio);

  const displayed = notes;
  const pinned = displayed.filter((n) => n.is_public_pinned);
  const rest = displayed.filter((n) => !n.is_public_pinned);

  function handleTogglePin(note: PublicNote) {
    const next = !note.is_public_pinned;
    // Optimistic flip in the local list so the hero card jumps immediately.
    const updated = notes.map((n) =>
      n.id === note.id ? { ...n, is_public_pinned: next } : n,
    );
    setLocalNotes(updated);
    patchNote(note.id, { is_public_pinned: next })
      .then(() => {
        queryClient.setQueryData(publicNotesListQueryOptions().queryKey, updated);
        setLocalNotes(null);
      })
      .catch((e) => {
        console.error("[public] toggle pin failed", e);
        setLocalNotes(null);
      });
  }

  return (
    <div style={{
      minHeight: "100vh",
      // Subtle warm gradient — reads less generic than flat #fff, but keeps
      // typography first. Almost-invisible green tint at the top echoes the
      // mascot palette without screaming "themed."
      background: "radial-gradient(ellipse 1100px 600px at 50% -10%, rgba(74,222,128,0.06), transparent 70%), linear-gradient(180deg, #fbfaf7 0%, #ffffff 40%)",
      fontFamily: FONT,
      color: "var(--gooni-text, #111)",
    }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px 120px" }}>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{
            fontFamily: DISPLAY,
            fontSize: 36,
            fontWeight: 500,
            letterSpacing: "-0.6px",
            marginBottom: 14,
            color: "var(--gooni-text, #111)",
          }}>
            hi, my name is daniel
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", color: "var(--gooni-muted, #8a8a8a)", fontSize: 13.5, minHeight: 18 }}>
            {profileLoading ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <PenIcon />
                  <Skeleton width={110} height={12} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <ClockIcon />
                  <Skeleton width={90} height={12} />
                </div>
                <Skeleton width={70} height={12} />
              </>
            ) : (
              <>
                {noteCount !== null && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <PenIcon />
                    <span>
                      {noteCount} notes written
                      {notes.length > 0 && noteCount > notes.length && (
                        <span style={{ color: "var(--gooni-faint, #c5c5c5)", marginLeft: 4 }}>· {notes.length} public</span>
                      )}
                    </span>
                  </div>
                )}
                {lastActive && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <ClockIcon />
                    <span>active {timeAgo(lastActive)}</span>
                  </div>
                )}
                {visitors !== null && visitors > 0 && (
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {visitors.toLocaleString()} {visitors === 1 ? "visitor" : "visitors"}
                  </span>
                )}
              </>
            )}
            <a
              href="/"
              style={{
                fontSize: 13, color: "var(--gooni-muted, #8a8a8a)", textDecoration: "none",
                fontFamily: FONT,
                display: "inline-flex", alignItems: "center", gap: 5,
                borderBottom: "1px dashed rgba(0,0,0,0.18)",
                paddingBottom: 1,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#111")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#8a8a8a")}
            >
              <SparkleIcon /> gooni
            </a>
            <Link
              to="/public/mcp"
              style={{
                fontSize: 13, color: "var(--gooni-muted, #8a8a8a)", textDecoration: "none",
                fontFamily: FONT,
                display: "inline-flex", alignItems: "center", gap: 5,
                borderBottom: "1px dashed rgba(0,0,0,0.18)",
                paddingBottom: 1,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#111")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#8a8a8a")}
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
                    background: "transparent", color: "var(--gooni-muted, #555)",
                    fontSize: 12, fontFamily: FONT, cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 5,
                  }}
                >
                  🔗 Link
                </button>
              </div>
              <EditorContent editor={bioEditor} />
              <div style={{ fontSize: 11.5, color: "var(--gooni-muted, #999)", marginTop: 6, fontFamily: FONT }}>
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
                    background: "transparent", color: "var(--gooni-muted, #555)", fontSize: 12.5,
                    fontFamily: FONT, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, margin: "14px 0 0" }}>
              {profileLoading ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                  <Skeleton width="92%" height={15} />
                  <Skeleton width="78%" height={15} />
                  <Skeleton width="55%" height={15} />
                </div>
              ) : bio ? (
                bioIsHtml ? (
                  <div
                    className="gooni-public-bio"
                    style={{ fontSize: 15.5, color: "var(--gooni-text, #444)", lineHeight: 1.7, flex: 1 }}
                    dangerouslySetInnerHTML={{ __html: bio }}
                  />
                ) : (
                  <p style={{ fontSize: 15.5, color: "var(--gooni-text, #444)", lineHeight: 1.7, margin: 0, whiteSpace: "pre-wrap", flex: 1 }}>
                    {bio}
                  </p>
                )
              ) : isOwner ? (
                <p style={{ fontSize: 15, color: "var(--gooni-faint, #bbb)", fontStyle: "italic", margin: 0, flex: 1 }}>
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
                    color: "var(--gooni-muted, #555)", fontSize: 12, cursor: "pointer", fontFamily: FONT,
                  }}
                >
                  Edit
                </button>
              )}
            </div>
          )}
        </div>

        {/* Bold cross-route CTA — bridges this list-view portfolio with
            the 3D plaza at /creative. The plaza surfaces these same
            public notes as floating coins on tiles, so this button is
            the "step inside" handshake from cold list to immersive
            reader. */}
        <div style={{ marginBottom: 32 }}>
          <PlazaCta />
        </div>


        {/* Pinned hero card skeleton — single placeholder during the
            initial fetch. We assume one pinned note for now; matches
            the actual card's padding + line heights so the real card
            slots in without shifting the rest of the page. */}
        {notesLoading && (
          <div style={{ marginBottom: 28 }}>
            <PinnedSkeleton />
          </div>
        )}

        {/* Pinned hero cards — public-pinned notes surfaced above the
            list. The owner pins via the pin button on a regular row;
            the hero card lets a YC reviewer (or anyone landing cold)
            hit the intro post first instead of scanning the list. */}
        {!notesLoading && pinned.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 28 }}>
            {pinned.map((note) => (
              <Link
                key={note.id}
                to="/public/$noteId"
                params={{ noteId: String(note.id) }}
                onMouseEnter={() => queryClient.prefetchQuery(publicNoteQueryOptions(note.id))}
                onFocus={() => queryClient.prefetchQuery(publicNoteQueryOptions(note.id))}
                style={{
                  display: "block",
                  padding: "20px 22px",
                  borderRadius: 16,
                  background: "linear-gradient(135deg, #ffffff 0%, #f9fbf7 100%)",
                  border: "1px solid rgba(74,222,128,0.30)",
                  boxShadow: "0 4px 14px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.03)",
                  textDecoration: "none",
                  color: "var(--gooni-text, #111)",
                  transition: "transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease",
                  position: "relative",
                }}
                onMouseOver={(e) => {
                  const el = e.currentTarget as HTMLAnchorElement;
                  el.style.transform = "translateY(-2px)";
                  el.style.boxShadow = "0 10px 28px rgba(0,0,0,0.07), 0 2px 6px rgba(0,0,0,0.04)";
                  el.style.borderColor = "rgba(74,222,128,0.55)";
                }}
                onMouseOut={(e) => {
                  const el = e.currentTarget as HTMLAnchorElement;
                  el.style.transform = "translateY(0)";
                  el.style.boxShadow = "0 4px 14px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.03)";
                  el.style.borderColor = "rgba(74,222,128,0.30)";
                }}
              >
                <div style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "#1b8b4a",
                  marginBottom: 8,
                }}>
                  <Pin size={11} strokeWidth={2.2} /> start here
                </div>
                <div style={{
                  fontFamily: DISPLAY,
                  fontSize: 25,
                  fontWeight: 500,
                  letterSpacing: "-0.3px",
                  marginBottom: 8,
                  lineHeight: 1.25,
                }}>
                  {displayTitle({ title: note.title, content: note.excerpt })}
                </div>
                <div style={{
                  fontSize: 14.5,
                  color: "var(--gooni-muted, #555)",
                  lineHeight: 1.6,
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}>
                  {note.excerpt}
                </div>
                <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--gooni-muted, #999)" }}>
                  {formatDate(note.updated_at)} · {note.read_time_minutes} min read
                </div>
                {isOwner && (
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleTogglePin(note);
                    }}
                    title="Unpin from public hero"
                    aria-label="Unpin from public hero"
                    style={{
                      position: "absolute",
                      top: 14,
                      right: 14,
                      background: "transparent",
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 999,
                      width: 28,
                      height: 28,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--gooni-muted, #666)",
                      cursor: "pointer",
                    }}
                  >
                    <PinOff size={13} strokeWidth={1.8} />
                  </button>
                )}
              </Link>
            ))}
          </div>
        )}

        {/* Section label between the pinned hero and the rest. Only renders
            when there's actually a pinned hero above the list — otherwise
            it'd dangle in front of the only section. */}
        {pinned.length > 0 && rest.length > 0 && (
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--gooni-faint, #a8a8a8)",
            marginBottom: 6,
          }}>
            more notes
          </div>
        )}

        {/* Notes list */}
        {notesLoading ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <NoteRowSkeleton key={i} />
            ))}
          </ul>
        ) : displayed.length === 0 ? (
          <p style={{ color: "var(--gooni-faint, #aaa)", fontSize: 14 }}>No posts yet.</p>
        ) : rest.length === 0 ? null : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {rest.map((note) => (
              <li
                key={note.id}
                onMouseEnter={() => {
                  setHoveredId(note.id);
                  // Warm the detail-page cache so the click feels instant.
                  // prefetchQuery is a no-op if the data is fresh, so spamming
                  // hovers across the list is cheap.
                  queryClient.prefetchQuery(publicNoteQueryOptions(note.id));
                }}
                onMouseLeave={() => setHoveredId((cur) => (cur === note.id ? null : cur))}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "16px 14px 16px 14px",
                  margin: "0 -14px",
                  borderBottom: "1px solid rgba(0,0,0,0.06)",
                  borderRadius: 8,
                  background: hoveredId === note.id ? "rgba(74,222,128,0.04)" : "transparent",
                  transition: "background 0.15s ease",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Link
                    to="/public/$noteId"
                    params={{ noteId: String(note.id) }}
                    onFocus={() => queryClient.prefetchQuery(publicNoteQueryOptions(note.id))}
                    style={{
                      fontFamily: DISPLAY,
                      fontSize: 18,
                      fontWeight: 500,
                      color: "var(--gooni-text, #111)",
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textDecoration: "none",
                      letterSpacing: "-0.1px",
                      transform: hoveredId === note.id ? "translateX(2px)" : "translateX(0)",
                      transition: "transform 0.15s ease",
                    }}
                  >
                    {displayTitle({ title: note.title, content: note.excerpt })}
                  </Link>
                  <span style={{ fontSize: 13, color: "var(--gooni-muted, #a0a0a0)", marginTop: 4, display: "block" }}>
                    {formatDate(note.updated_at)}
                    <span style={{ color: "#cfcfcf" }}> · {note.read_time_minutes} min</span>
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  {/* Owner-only: pin to public hero. */}
                  {isOwner && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleTogglePin(note);
                      }}
                      title="Pin to public hero"
                      aria-label={`Pin "${displayTitle({ title: note.title, content: note.excerpt })}" to public hero`}
                      style={{
                        background: "transparent",
                        border: "1px solid rgba(0,0,0,0.10)",
                        borderRadius: 999,
                        width: 26, height: 26,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        color: "var(--gooni-text, #444)",
                        cursor: "pointer",
                        opacity: hoveredId === note.id ? 1 : 0,
                        transition: "opacity 0.15s ease",
                      }}
                      onFocus={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
                    >
                      <Pin size={12} strokeWidth={1.8} />
                    </button>
                  )}
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
                        color: "var(--gooni-text, #444)",
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
                    <span style={{ fontSize: 11.5, color: "var(--gooni-muted, #9a9a9a)", border: "1px solid rgba(0,0,0,0.10)", borderRadius: 10, padding: "2px 8px", fontWeight: 500 }}>
                      {note.space_name}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Footer signature — small + quiet, just enough to ground the page
            so it doesn't feel like content stops mid-air. */}
        <div style={{
          marginTop: 80,
          paddingTop: 22,
          borderTop: "1px solid rgba(0,0,0,0.06)",
          fontSize: 12,
          color: "var(--gooni-faint, #b5b5b5)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}>
          <span>written in <span style={{ color: "#4ADE80", fontWeight: 600 }}>gooni</span>, my personal AI notebook</span>
          <a
            href="https://github.com/gub1th/gooni"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--gooni-faint, #b5b5b5)", textDecoration: "none", borderBottom: "1px dashed rgba(0,0,0,0.12)" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#777")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#b5b5b5")}
          >
            source on github
          </a>
        </div>
      </div>

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
            background: ctok.text,
            color: "#FFF",
            padding: "10px 14px 10px 16px",
            borderRadius: 999,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            fontSize: 13.5,
            fontFamily: FONT,
            zIndex: z.toast,
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

// Hero-card skeleton — geometry mirrors the pinned <Link> above so the
// real card drops in without nudging anything below it. One placeholder
// is enough for the cold-load case (the page assumes a single pinned
// note for now).
function PinnedSkeleton() {
  return (
    <div
      aria-hidden
      style={{
        display: "block",
        padding: "20px 22px",
        borderRadius: 16,
        background: "linear-gradient(135deg, #ffffff 0%, #f9fbf7 100%)",
        border: "1px solid rgba(74,222,128,0.20)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.03)",
      }}
    >
      <Skeleton width={84} height={11} radius={4} style={{ marginBottom: 12 }} />
      <div style={{ marginBottom: 12 }}>
        <Skeleton width="72%" height={22} radius={5} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Skeleton width="100%" height={13} />
        <Skeleton width="92%" height={13} />
        <Skeleton width="64%" height={13} />
      </div>
      <div style={{ marginTop: 14 }}>
        <Skeleton width={140} height={11} radius={4} />
      </div>
    </div>
  );
}

// Row-level skeleton matching the rendered `more notes` <li> heights so
// the real list slots in cleanly when the fetch resolves.
function NoteRowSkeleton() {
  return (
    <li
      aria-hidden
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 16,
        padding: "16px 14px",
        margin: "0 -14px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <Skeleton width="62%" height={18} radius={5} />
        <Skeleton width={120} height={12} />
      </div>
    </li>
  );
}
