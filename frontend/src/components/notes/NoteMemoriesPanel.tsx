import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ApiMemory } from "../../services/api";
import { color as ctok, FONT } from "../../ui";


// Per-note memories panel. Designed to match the redesign mockup
// (`gooni_memories_section_redesign.html`): a flat list of pills + single-
// line previews + chevron. Click peeks; "View all memories →" deep-links
// to the full brain on /memories. The animated brain rendering still
// lives in MemoryBrain — used by the /memories page itself.
//
// Pill palette is per memory type; colours mirror the soft pastel tokens
// from the mockup (preference / context / decision) and extend them to
// the rest of the type set so existing memory kinds keep their semantic
// colour without losing the visual shape.
const PALETTE: Record<string, { bg: string; fg: string }> = {
  preference: { bg: "#EEEDFE", fg: "#3C3489" }, // violet
  goal:       { bg: "#E1F5EE", fg: "#085041" }, // green   — "decision"-ish
  fact:       { bg: "#E6F1FB", fg: "#0C447C" }, // blue    — "context"
  routine:    { bg: "#E6F4F1", fg: "#0F5750" }, // teal
  constraint: { bg: "#FDE9F0", fg: "#9C2A5B" }, // rose
  episode:    { bg: "#F1ECFB", fg: "#4A2A8A" }, // lavender
  default:    { bg: "#F1F1F4", fg: "#3F3F46" }, // neutral
};

function paletteFor(type: string) {
  return PALETTE[type] ?? PALETTE.default;
}

interface NoteMemoriesPanelProps {
  memories: ApiMemory[];
}

export function NoteMemoriesPanel({ memories }: NoteMemoriesPanelProps) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ApiMemory | null>(null);

  // Close popover on Escape — outside-click handled by the backdrop.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  if (memories.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 24,
        paddingTop: 16,
        borderTop: "1px solid rgba(0,0,0,0.06)",
        fontFamily: FONT,
        position: "relative",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#94A3B8",
          marginBottom: 8,
        }}
      >
        Memories from this note
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {memories.map((m) => {
          const palette = paletteFor(m.type);
          return (
            <button
              key={m.id}
              onClick={() => setSelected(selected?.id === m.id ? null : m)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "rgba(15,23,42,0.03)",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: FONT,
                width: "100%",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.06)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.03)";
              }}
              title={m.content}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: palette.fg,
                  background: palette.bg,
                  padding: "2px 8px",
                  borderRadius: 99,
                  flexShrink: 0,
                }}
              >
                {m.type}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: "#1E293B",
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {m.content}
              </span>
              <ChevronRight size={14} color="#94A3B8" style={{ flexShrink: 0 }} />
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 8, padding: "0 4px", fontSize: 12, color: "#94A3B8" }}>
        Click a row to peek.{" "}
        <button
          onClick={() => navigate({ to: "/memories", search: { focus: undefined } })}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "#2563EB",
            cursor: "pointer",
            fontFamily: FONT,
            fontSize: 12,
          }}
        >
          View all memories →
        </button>
      </div>

      {/* Peek popover — inline detail card sourced from the row click.
          Click the backdrop or hit Escape to dismiss. "view memory →"
          deep-links to /memories?focus=<id> which opens the detail
          modal in place. */}
      {selected && (
        <>
          <div
            onClick={() => setSelected(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "transparent",
              zIndex: 4,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: "100%",
              marginTop: 6,
              background: "#fff",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.10)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.06)",
              padding: "12px 14px",
              zIndex: 5,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: paletteFor(selected.type).fg,
                  background: paletteFor(selected.type).bg,
                  padding: "2px 8px",
                  borderRadius: 99,
                }}
              >
                {selected.type}
              </span>
              <span style={{ fontSize: 11, color: "#94A3B8" }}>
                conf {Math.round(selected.confidence * 100)}%
              </span>
              <button
                onClick={() => setSelected(null)}
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: ctok.muted,
                  fontSize: 16,
                  lineHeight: 1,
                  padding: 2,
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div style={{ fontSize: 13, color: ctok.text, lineHeight: 1.5, marginBottom: 10 }}>
              {selected.content}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  const id = selected.id;
                  setSelected(null);
                  navigate({ to: "/memories", search: { focus: id } });
                }}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: FONT,
                  padding: "5px 12px",
                  borderRadius: 999,
                  background: ctok.text,
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                view memory →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
