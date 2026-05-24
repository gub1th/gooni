import { useEffect, useRef, useState } from "react";
import { MODELS, useModelStore, type ModelId } from "../stores/useModelStore";
import { FONT } from "../ui";


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
          fontSize: 12, fontFamily: FONT, fontWeight: 500,
          color: "#3C3C43",
          background: "transparent",
          border: "none",
          borderRadius: 6,
          padding: "4px 6px",
          cursor: "pointer",
          display: "inline-flex", alignItems: "center", gap: 4,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        <span>{current.label}</span>
        <span style={{ fontSize: 9, color: "var(--gooni-muted, #8E8E93)", marginLeft: 1 }}>▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            minWidth: 240,
            background: "var(--gooni-card, #fff)",
            border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
            borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)",
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
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 6,
                  // Unselected: no chrome at all (just hover bg). Selected:
                  // darker bg only — no border, no accent — matches Claude.
                  background: active ? "rgba(0,0,0,0.06)" : "transparent",
                  border: "none", cursor: "pointer", textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                  <span style={{
                    fontFamily: FONT, fontWeight: 600, fontSize: 12.5,
                    color: "var(--gooni-text, #1C1C1E)",
                  }}>
                    {m.label}
                  </span>
                  {m.tagline && (
                    <span style={{
                      fontFamily: FONT,
                      fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
                      fontWeight: 400,
                    }}>
                      {m.tagline}
                    </span>
                  )}
                </div>
                {/* Check moves to right edge — Claude's pattern. Only renders
                    when active, so unselected rows have zero chrome. */}
                {active && (
                  <span style={{
                    color: "#30A14E", fontSize: 14, flexShrink: 0,
                    lineHeight: 1,
                  }}>✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
