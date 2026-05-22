import { useEffect, useRef, useState } from "react";
import { SpaceIcon, SPACE_ICON_OPTIONS, lucideIconValue } from "./SpaceIcon";

/**
 * Optional Notion-style note icon. Renders centered above the note
 * title. Click → palette popover. Click outside → close. "Remove"
 * action when an icon is already set.
 *
 * Storage encoding matches Space.emoji: lucide-icon names are stored
 * as "lucide:<name>" strings; literal unicode emojis are stored raw.
 * SpaceIcon handles both shapes.
 */
export function NoteIconPicker({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div
      ref={ref}
      style={{
        display: "inline-flex",
        position: "relative",
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        title={current ? "Change icon" : "Add icon"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: current ? 34 : 22,
          height: current ? 34 : 22,
          borderRadius: 8,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: current ? "#1C1C1E" : "rgba(142,142,147,0.55)",
          fontSize: current ? 26 : 10,
          fontWeight: current ? 400 : 500,
          letterSpacing: current ? 0 : 0.4,
          textTransform: current ? "none" : "uppercase",
          transition: "background 0.12s, color 0.12s",
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "rgba(15,23,42,0.06)";
          if (!current) (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          if (!current) (e.currentTarget as HTMLButtonElement).style.color = "rgba(142,142,147,0.55)";
        }}
      >
        {current ? (
          <SpaceIcon emoji={current} size={22} color="#1C1C1E" />
        ) : (
          "+ icon"
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: "#fff",
            borderRadius: 10,
            padding: 8,
            boxShadow:
              "0 12px 28px rgba(15,23,42,0.16), 0 2px 6px rgba(15,23,42,0.10), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
            width: 224,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, 1fr)",
              gap: 2,
            }}
          >
            {SPACE_ICON_OPTIONS.map(({ name, Icon }) => {
              const value = lucideIconValue(name);
              const selected = current === value;
              return (
                <button
                  key={name}
                  onClick={() => {
                    onPick(value);
                    setOpen(false);
                  }}
                  title={name}
                  style={{
                    background: selected ? "rgba(15,23,42,0.08)" : "transparent",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    height: 30,
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: selected ? "#0F172A" : "#475569",
                    transition: "background 0.1s, color 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!selected)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "rgba(15,23,42,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    if (!selected)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "transparent";
                  }}
                >
                  <Icon size={16} strokeWidth={1.8} />
                </button>
              );
            })}
          </div>
          {current && (
            <button
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              style={{
                marginTop: 6,
                width: "100%",
                padding: "5px 8px",
                borderRadius: 6,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "#EF4444",
                fontSize: 12,
                fontWeight: 500,
                fontFamily:
                  "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background =
                  "rgba(239,68,68,0.08)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background =
                  "transparent")
              }
            >
              Remove icon
            </button>
          )}
        </div>
      )}
    </div>
  );
}
