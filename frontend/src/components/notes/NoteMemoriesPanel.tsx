import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ApiMemory } from "../../services/api";
import { frostInk as ctok, FONT } from "../../ui";


// Per-note memories panel. Designed to match the redesign mockup
// (`gooni_memories_section_redesign.html`): a flat list of pills + single-
// line previews + chevron. Click peeks; "View all memories →" deep-links
// to the full brain on /memories. The animated brain rendering still
// lives in MemoryBrain — used by the /memories page itself.
//
// Per-type pills. Same correction MemoryBrain's bubbles got: these were soft
// PASTEL PLATES from the original mockup — a light fill with dark ink on it —
// which is a small white pill once the surface underneath is the void. Bright
// hue as text over a 14% tint of itself instead, the `accent`/`accentDim` shape,
// which is the only form that works unchanged in both themes.
//
// Hues match `MemoriesView`'s `TYPE_COLORS` and `MemoryBrain`'s, so a `goal` is
// one colour everywhere it is shown rather than three.
const PALETTE: Record<string, { bg: string; fg: string }> = {
  preference: { bg: "rgba(74,222,128,0.14)",  fg: "#4ADE80" },
  goal:       { bg: "rgba(167,139,250,0.16)", fg: "#A78BFA" },
  fact:       { bg: "rgba(96,165,250,0.16)",  fg: "#60A5FA" },
  routine:    { bg: "rgba(251,146,60,0.15)",  fg: "#FB923C" },
  constraint: { bg: "rgba(248,113,113,0.15)", fg: "#F87171" },
  episode:    { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF" },
  default:    { bg: "rgba(156,163,175,0.14)", fg: "#9CA3AF" },
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
        borderTop: `1px solid ${ctok.hairline}`,
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
          color: ctok.faint,
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
                  color: ctok.text,
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

      <div style={{ marginTop: 8, padding: "0 4px", fontSize: 12, color: ctok.faint }}>
        Click a row to peek.{" "}
        <button
          onClick={() => navigate({ to: "/", search: { view: "memories" } })}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: ctok.accent,
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
              background: ctok.card,
              borderRadius: 12,
              border: `1px solid ${ctok.hairline}`,
              boxShadow: "none",
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
              <span style={{ fontSize: 11, color: ctok.faint }}>
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
                  navigate({ to: "/", search: { view: "memories", focus: id } });
                }}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: FONT,
                  padding: "5px 12px",
                  borderRadius: 999,
                  background: ctok.text,
                  color: ctok.card,
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
