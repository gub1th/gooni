import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  fetchFocuses, createItem,
  type ApiFocus,
} from "../../services/api";
import { FocusCard } from "./FocusCard";
import { SynthesizerSection } from "./SynthesizerSection";
import { FocusDrillDown } from "./FocusDrillDown";

// FocusesView — Focuses tab content. Synthesizer audit pills first
// (proposed candidates → promote/dismiss inline), then the 3-col grid
// of active focuses w/ drift / dormant / lineage states. Manual
// creation lives as a small "+ manual" affordance on the section
// header — explicitly demoted now that synth surfaces the same shape
// automatically.
//
// The top-of-dashboard TakeTabs already shows Gooni's focus take, so
// this view doesn't duplicate it.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

export function FocusesView() {
  const qc = useQueryClient();
  const [drillId, setDrillId] = useState<number | null>(null);

  const { data: focuses = [] } = useQuery<ApiFocus[]>({
    queryKey: ["focuses"],
    queryFn: fetchFocuses,
  });

  const handleManualAdd = async () => {
    const text = window.prompt("New focus name?");
    if (!text?.trim()) return;
    try {
      await createItem({ text: text.trim(), committed: true });
      qc.invalidateQueries({ queryKey: ["focuses"] });
    } catch (e) { console.error(e); }
  };

  const handleArchive = async (id: number) => {
    if (!window.confirm("Archive this focus? Linked todos lose their dot.")) return;
    const { deleteFocus } = await import("../../services/api");
    await deleteFocus(id);
    qc.invalidateQueries({ queryKey: ["focuses"] });
  };

  return (
    <div style={{ fontFamily: FONT }}>
      {/* Synthesizer audit pills — proposed candidates first. */}
      <div style={{
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 12, padding: "12px 16px",
        marginBottom: 14,
      }}>
        <SynthesizerSection />
      </div>

      {/* Section header + "+ manual" demoted creation */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8, padding: "0 2px",
      }}>
        <span style={{
          fontSize: 12, fontWeight: 500,
          color: "var(--gooni-muted, #8E8E93)",
          letterSpacing: 0.4, textTransform: "uppercase",
        }}>
          Focuses
        </span>
        <button
          onClick={handleManualAdd}
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--gooni-muted, #8E8E93)", fontSize: 11,
            fontFamily: FONT, padding: 0,
          }}
        >
          <Plus size={11} /> manual
        </button>
      </div>

      {/* 3-col grid */}
      {focuses.length === 0 ? (
        <div style={{
          padding: "20px 0", fontSize: 13,
          color: "var(--gooni-muted, #8E8E93)",
          textAlign: "center",
        }}>
          No focuses yet. Promote a candidate above or click '+ manual'.
        </div>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 10,
        }}>
          {focuses.map((f) => (
            <FocusCard
              key={f.id}
              focus={f}
              onOpen={() => setDrillId(f.id)}
              onArchive={handleArchive}
            />
          ))}
        </div>
      )}

      <FocusDrillDown focusId={drillId} onClose={() => setDrillId(null)} />
    </div>
  );
}
