import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchPublicNotes, fetchPublicProfile, type PublicNote } from "../services/api";

export const Route = createFileRoute("/public/")({
  component: PublicPage,
});

function formatPublicDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function PublicPage() {
  const [tab, setTab] = useState<"posts" | "about">("posts");
  const [notes, setNotes] = useState<PublicNote[]>([]);
  const [bio, setBio] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    fetchPublicNotes().then(setNotes).catch(() => {});
    fetchPublicProfile().then((p) => setBio(p.bio)).catch(() => {});
  }, []);

  const spaceNames = Array.from(
    new Set(notes.map((n) => n.space_name).filter((s): s is string => s !== null))
  );

  const displayed = filter ? notes.filter((n) => n.space_name === filter) : notes;

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
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 48 }}>
          <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.3px" }}>daniel gunawan</span>
          <div style={{ display: "flex", gap: 20 }}>
            {(["posts", "about"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 14, color: tab === t ? "#111" : "#888",
                  fontWeight: tab === t ? 600 : 400, padding: 0,
                  fontFamily: "inherit",
                  borderBottom: tab === t ? "2px solid #111" : "2px solid transparent",
                  paddingBottom: 2, transition: "color 0.15s",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {tab === "posts" && (
          <>
            {spaceNames.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 32, flexWrap: "wrap" }}>
                {spaceNames.map((name) => {
                  const active = filter === name;
                  return (
                    <button
                      key={name}
                      onClick={() => setFilter(active ? null : name)}
                      style={{
                        padding: "4px 12px", borderRadius: 20,
                        border: `1px solid ${active ? "#111" : "rgba(0,0,0,0.18)"}`,
                        background: active ? "#111" : "transparent",
                        color: active ? "#fff" : "#555",
                        fontSize: 12.5, cursor: "pointer", fontFamily: "inherit",
                        transition: "background 0.15s, color 0.15s",
                      }}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}

            {displayed.length === 0 ? (
              <p style={{ color: "#aaa", fontSize: 14 }}>No posts yet.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {displayed.map((note) => (
                  <li
                    key={note.id}
                    style={{
                      display: "flex", alignItems: "baseline",
                      justifyContent: "space-between", gap: 16,
                      padding: "14px 0", borderBottom: "1px solid rgba(0,0,0,0.07)",
                    }}
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
                        ({formatPublicDate(note.updated_at)})
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
          </>
        )}

        {tab === "about" && (
          <div style={{ fontSize: 15, lineHeight: 1.75, color: "#222", whiteSpace: "pre-wrap" }}>
            {bio ? bio : <span style={{ color: "#aaa" }}>No bio yet.</span>}
          </div>
        )}
      </div>
    </div>
  );
}
