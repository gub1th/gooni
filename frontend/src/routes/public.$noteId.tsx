import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchPublicNote, type PublicNoteDetail } from "../services/api";

export const Route = createFileRoute("/public/$noteId")({
  component: PublicNotePage,
});

function formatPublicDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function PublicNotePage() {
  const { noteId } = Route.useParams();
  const [note, setNote] = useState<PublicNoteDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetchPublicNote(Number(noteId))
      .then(setNote)
      .catch(() => setNotFound(true));
  }, [noteId]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#fff",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#111",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px 120px" }}>
        {/* Back link */}
        <Link
          to="/public"
          style={{ fontSize: 13.5, color: "#888", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 40 }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#111")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.color = "#888")}
        >
          ← back
        </Link>

        {notFound ? (
          <p style={{ color: "#aaa", fontSize: 15 }}>Note not found or not public.</p>
        ) : !note ? (
          <p style={{ color: "#ccc", fontSize: 15 }}>Loading…</p>
        ) : (
          <>
            {note.space_name && (
              <span style={{ fontSize: 11.5, color: "#888", border: "1px solid rgba(0,0,0,0.15)", borderRadius: 12, padding: "2px 8px", marginBottom: 16, display: "inline-block" }}>
                {note.space_name}
              </span>
            )}
            <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", margin: "12px 0 8px", lineHeight: 1.25 }}>
              {note.title || "Untitled"}
            </h1>
            <p style={{ fontSize: 13, color: "#999", margin: "0 0 40px" }}>
              {formatPublicDate(note.updated_at)}
            </p>
            <div
              style={{ fontSize: 16, lineHeight: 1.75, color: "#222" }}
              dangerouslySetInnerHTML={{ __html: note.content || "" }}
            />
          </>
        )}
      </div>
    </div>
  );
}
