import { useEffect, useRef, useState } from "react";
import { MODELS, useModelStore, type ModelId } from "../stores/useModelStore";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";
// Tagline gets a different family (slimmer + italic-feeling) so it
// reads as ancillary copy, not a model name.
const TAGLINE_FONT = "'Iowan Old Style', Georgia, 'Times New Roman', serif";

// Custom dropdown — replaces the OS-native <select> so it matches the
// rest of the chat panel chrome. Closed state shows ONLY the label;
// taglines live inside the open menu in a smaller serif so they
// clearly read as extra info, not part of the model name.
export function ModelSelector() {
  const { model, setModel } = useModelStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = MODELS.find((m) => m.id === model) ?? MODELS[0];

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={current.tagline}
        style={{
          fontSize: 11, fontFamily: FONT, fontWeight: 500,
          color: "#3C3C43",
          background: "rgba(0,0,0,0.04)",
          border: "1px solid rgba(0,0,0,0.10)",
          borderRadius: 6,
          padding: "3px 8px",
          cursor: "pointer",
          display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        <span>{current.label}</span>
        <span style={{ fontSize: 8, color: "#8E8E93" }}>▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            minWidth: 220,
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)",
            padding: 4,
            zIndex: 1200,
          }}
        >
          {MODELS.map((m) => {
            const active = m.id === model;
            return (
              <button
                key={m.id}
                onClick={() => { setModel(m.id as ModelId); setOpen(false); }}
                style={{
                  width: "100%",
                  display: "flex", flexDirection: "column", alignItems: "flex-start",
                  gap: 1,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: active ? "rgba(74,222,128,0.10)" : "transparent",
                  border: "none", cursor: "pointer", textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <span style={{
                  fontFamily: FONT, fontWeight: 600, fontSize: 12.5,
                  color: "#1C1C1E",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  {active && <span style={{ color: "#30A14E" }}>✓</span>}
                  {m.label}
                </span>
                <span style={{
                  fontFamily: TAGLINE_FONT,
                  fontSize: 11, color: "#8E8E93",
                  fontStyle: "italic",
                  paddingLeft: active ? 18 : 0,
                }}>
                  {m.tagline}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
