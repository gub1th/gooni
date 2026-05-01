import { useEffect } from "react";
import { GOONI_FACES, GOONI_FACE_LABELS, useGooniFaceStore, type GooniFace } from "../stores/useGooniFaceStore";
import { GOONI_THEMES, GOONI_THEME_LABELS, THEME_PALETTES, useGooniThemeStore, type GooniTheme } from "../stores/useGooniThemeStore";
import { GooniFacePreview } from "./GooniMascot";
import { SettingsPanel } from "./SettingsPanel";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const selectedFace = useGooniFaceStore((s) => s.face);
  const setFace = useGooniFaceStore((s) => s.setFace);
  const selectedTheme = useGooniThemeStore((s) => s.theme);
  const setTheme = useGooniThemeStore((s) => s.setTheme);
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          border: "0.5px solid rgba(0,0,0,0.1)",
          borderRadius: 14,
          padding: "22px 24px 24px",
          width: 460,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 80px)",
          overflowY: "auto",
          position: "relative",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close settings"
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 26,
            height: 26,
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "#8E8E93",
            fontSize: 16,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.1s, color 0.1s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)";
            (e.currentTarget as HTMLButtonElement).style.color = "#1C1C1E";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            (e.currentTarget as HTMLButtonElement).style.color = "#8E8E93";
          }}
        >
          ×
        </button>

        <h2 style={{
          fontSize: 16, fontWeight: 600, color: "#1C1C1E", margin: 0, marginBottom: 18,
          letterSpacing: "-0.2px",
        }}>Settings</h2>

        <section style={{ marginBottom: 22 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "#8E8E93",
            letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 12,
          }}>
            theme
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {GOONI_THEMES.map((t: GooniTheme) => {
              const p = THEME_PALETTES[t];
              const selected = selectedTheme === t;
              return (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  title={GOONI_THEME_LABELS[t]}
                  style={{
                    padding: 6,
                    borderRadius: 10,
                    background: "transparent",
                    border: "none",
                    outline: selected ? "2px solid #4ADE80" : "1px solid rgba(0,0,0,0.08)",
                    outlineOffset: selected ? "-2px" : "-1px",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                    transition: "outline-color 0.12s",
                  }}
                >
                  {/* Two-tone swatch: left half = sidebar, right half = main */}
                  <div style={{
                    width: 48, height: 40, borderRadius: 6, overflow: "hidden",
                    display: "flex",
                    border: "0.5px solid rgba(0,0,0,0.08)",
                  }}>
                    <div style={{ flex: 1, background: p.sidebar }} />
                    <div style={{ flex: 1, background: p.main }} />
                  </div>
                  <div style={{
                    fontSize: 10.5, color: selected ? "#1C1C1E" : "#8E8E93",
                    textTransform: "lowercase", letterSpacing: 0.2,
                    fontWeight: selected ? 600 : 400,
                  }}>
                    {GOONI_THEME_LABELS[t]}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "#8E8E93",
            letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 12,
          }}>
            gooni's face
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
            {GOONI_FACES.map((f: GooniFace) => {
              const selected = selectedFace === f;
              return (
                <button
                  key={f}
                  onClick={() => setFace(f)}
                  title={GOONI_FACE_LABELS[f]}
                  style={{
                    padding: 6,
                    borderRadius: 10,
                    background: selected ? "#fff" : "transparent",
                    border: "none",
                    outline: selected ? "2px solid #4ADE80" : "1px solid rgba(0,0,0,0.08)",
                    outlineOffset: selected ? "-2px" : "-1px",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    transition: "background 0.12s, outline-color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.03)"; }}
                  onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <GooniFacePreview face={f} size={36} />
                  <div style={{
                    fontSize: 9.5, color: selected ? "#1C1C1E" : "#8E8E93",
                    textTransform: "lowercase", letterSpacing: 0.2, lineHeight: 1.1,
                    textAlign: "center", minHeight: 22, fontWeight: selected ? 600 : 400,
                  }}>
                    {GOONI_FACE_LABELS[f]}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Daily nudge — moved off the dashboard so the home screen stays
            for actual content. Same component, just rendered here now. */}
        <div style={{
          marginTop: 22,
          paddingTop: 20,
          borderTop: "0.5px solid rgba(0,0,0,0.08)",
        }}>
          <SettingsPanel />
        </div>
      </div>
    </div>
  );
}
