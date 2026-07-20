import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { fetchNote, touchNote, type ApiNote } from "../../services/api";

// Inline note reader for the ambient home. A recall suggestion opens here as a
// frosted panel over the black — you read the note without ever going "into the
// app" (sidebar → notes → open). Escape / click-away / × closes back to the
// wave. List-view notes ship no body, so we fetch the full note on open.

export function NotePeek({ note, onClose }: { note: ApiNote; onClose: () => void }) {
  const [full, setFull] = useState<ApiNote>(note);

  useEffect(() => {
    let live = true;
    void fetchNote(note.id).then((n) => { if (live) setFull(n); }).catch(() => {});
    void touchNote(note.id).catch(() => {});
    return () => { live = false; };
  }, [note.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const html = full.content ?? "";

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 8, fontFamily: FONT,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
      }}
    >
      <div
        style={{
          position: "relative", width: "min(680px, 88vw)", maxHeight: "76vh", overflowY: "auto",
          borderRadius: 22, padding: "34px 40px 40px",
          background: "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 62%, transparent)",
          backdropFilter: "blur(26px)", WebkitBackdropFilter: "blur(26px)",
          border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.12)", boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          color: "rgb(var(--gooni-ink, 244 245 244))",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute", top: 16, right: 18, width: 26, height: 26, borderRadius: 999,
            border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.18)", background: "transparent",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.55)", cursor: "pointer", fontSize: 14, lineHeight: 1,
          }}
        >
          ×
        </button>

        {full.title && (
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 16px", letterSpacing: -0.2 }}>
            {full.title}
          </h1>
        )}

        <div
          className="gooni-note-peek"
          style={{ fontSize: 15, lineHeight: 1.62, color: "rgb(var(--gooni-ink, 244 245 244) / 0.9)" }}
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <style>{`
          .gooni-note-peek img { max-width: 100%; border-radius: 8px; }
          .gooni-note-peek a { color: ${"#4ADE80"}; }
          .gooni-note-peek h1, .gooni-note-peek h2, .gooni-note-peek h3 { color: rgb(var(--gooni-ink, 244 245 244)); }
          .gooni-note-peek pre { background: rgba(0,0,0,0.35); padding: 12px; border-radius: 8px; overflow-x: auto; }
          .gooni-note-peek code { background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 4px; }
          .gooni-note-peek ul, .gooni-note-peek ol { padding-left: 22px; }
        `}</style>
      </div>
    </div>
  );
}
