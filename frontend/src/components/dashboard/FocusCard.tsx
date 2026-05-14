import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  renameFocus, forkFocus, reactivateFocus,
  type ApiFocus,
} from "../../services/api";

// FocusCard — one card in the 3-col grid on the Focuses tab. Renders
// three states:
//   normal   — color dot + name + signals count + progress bar
//   drifting — amber dot in corner + "drifting" subtitle + clickable
//              dot opens Rename / Fork popover
//   dormant  — 50% opacity + grey dot + "dormant" subtitle + zero
//              progress + click → Reactivate / Archive popover
// Lineage breadcrumb ("evolved from X") below name when set.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  focus: ApiFocus;
  onOpen: () => void;
  onArchive: (id: number) => void;
}

export function FocusCard({ focus, onOpen, onArchive }: Props) {
  const qc = useQueryClient();
  const isDormant = focus.status === "dormant";
  const isDrifting = focus.drift_flagged_at != null && !isDormant;
  const [showDriftMenu, setShowDriftMenu] = useState(false);
  const [showDormantMenu, setShowDormantMenu] = useState(false);
  const driftRef = useRef<HTMLDivElement | null>(null);
  const dormantRef = useRef<HTMLDivElement | null>(null);

  // Close popovers on outside-click. Both menus share the same handler
  // because only one can be open at a time per card.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (driftRef.current && !driftRef.current.contains(t)) setShowDriftMenu(false);
      if (dormantRef.current && !dormantRef.current.contains(t)) setShowDormantMenu(false);
    };
    if (showDriftMenu || showDormantMenu) {
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }
  }, [showDriftMenu, showDormantMenu]);

  const handleRename = async () => {
    const next = window.prompt(`Rename "${focus.text}" to:`, focus.text);
    if (!next || !next.trim() || next.trim() === focus.text) return;
    try {
      await renameFocus(focus.id, { text: next.trim() });
      qc.invalidateQueries({ queryKey: ["focuses"] });
      setShowDriftMenu(false);
    } catch (e) { console.error(e); }
  };

  const handleFork = async () => {
    const next = window.prompt(
      `Fork "${focus.text}" — new name?\n(Original kept as 'evolved')`,
    );
    if (!next || !next.trim()) return;
    try {
      await forkFocus(focus.id, { new_text: next.trim() });
      qc.invalidateQueries({ queryKey: ["focuses"] });
      setShowDriftMenu(false);
    } catch (e) { console.error(e); }
  };

  const handleReactivate = async () => {
    try {
      await reactivateFocus(focus.id);
      qc.invalidateQueries({ queryKey: ["focuses"] });
      setShowDormantMenu(false);
    } catch (e) { console.error(e); }
  };

  const handleArchive = () => {
    onArchive(focus.id);
    setShowDormantMenu(false);
  };

  const progress = focus.progress;
  const progressPct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;

  const dotColor = isDormant
    ? "#9CA3AF"
    : (focus.color || "#22C55E");

  return (
    <div
      onClick={(e) => {
        // Don't bubble through menu clicks; FocusCard click opens drill-down.
        if ((e.target as HTMLElement).closest("[data-noopen]")) return;
        onOpen();
      }}
      style={{
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
        borderRadius: 12,
        padding: "12px 14px",
        cursor: "pointer",
        position: "relative",
        opacity: isDormant ? 0.55 : 1,
        fontFamily: FONT,
        transition: "transform 0.1s",
      }}
    >
      {/* Drift dot in corner */}
      {isDrifting && (
        <div
          ref={driftRef}
          data-noopen
          style={{ position: "absolute", top: 8, right: 8 }}
        >
          <div
            onClick={(e) => { e.stopPropagation(); setShowDriftMenu((v) => !v); }}
            title="Focus has drifted from origin"
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "#EF9F27", cursor: "pointer",
              boxShadow: "0 0 0 2px rgba(239,159,39,0.2)",
            }}
          />
          {showDriftMenu && (
            <div style={{
              position: "absolute", top: 16, right: 0,
              background: "var(--gooni-card, #fff)",
              border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
              borderRadius: 8, padding: 4,
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
              zIndex: 20, minWidth: 120,
            }}>
              <MenuItem label="Rename" onClick={handleRename} />
              <MenuItem label="Fork" onClick={handleFork} />
            </div>
          )}
        </div>
      )}

      {/* Name + dot */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%", background: dotColor,
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 13, fontWeight: 500, color: "var(--gooni-text, #1C1C1E)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          minWidth: 0, flex: 1,
        }}>
          {focus.text}
        </span>
      </div>

      {/* Lineage breadcrumb */}
      {focus.evolved_from_name && (
        <div style={{
          fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
          marginBottom: 4, fontStyle: "italic",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          ↑ evolved from '{focus.evolved_from_name}'
        </div>
      )}

      {/* Status line */}
      <div
        ref={isDormant ? dormantRef : undefined}
        data-noopen={isDormant ? "true" : undefined}
        onClick={isDormant ? (e) => { e.stopPropagation(); setShowDormantMenu((v) => !v); } : undefined}
        style={{
          fontSize: 11,
          color: isDormant ? "var(--gooni-muted, #8E8E93)" :
                 isDrifting ? "#854F0B" : "var(--gooni-muted, #8E8E93)",
          cursor: isDormant ? "pointer" : "default",
          textDecoration: isDormant ? "underline dotted" : "none",
          position: "relative",
        }}
      >
        {isDormant ? "dormant" :
         isDrifting ? "drifting" :
         `${focus.signals_count} signal${focus.signals_count === 1 ? "" : "s"}`}

        {isDormant && showDormantMenu && (
          <div style={{
            position: "absolute", top: 18, left: 0,
            background: "var(--gooni-card, #fff)",
            border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
            borderRadius: 8, padding: 4,
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            zIndex: 20, minWidth: 130,
          }}>
            <MenuItem label="Reactivate" onClick={handleReactivate} />
            <MenuItem label="Archive" onClick={handleArchive} />
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div style={{
        height: 3,
        background: "rgba(0,0,0,0.06)",
        borderRadius: 2,
        overflow: "hidden",
        marginTop: 8,
      }}>
        <div style={{
          width: `${isDormant ? 0 : progressPct}%`,
          height: "100%",
          background: dotColor,
          borderRadius: 2,
        }} />
      </div>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left",
        padding: "6px 10px", border: "none", background: "transparent",
        cursor: "pointer", fontSize: 12,
        color: "var(--gooni-text, #1C1C1E)",
        borderRadius: 6, fontFamily: FONT,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.04)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {label}
    </button>
  );
}
