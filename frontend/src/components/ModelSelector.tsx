import { MODELS, useModelStore, type ModelId } from "../stores/useModelStore";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

// Generic dropdown — replaced the per-model pill row so the list can grow
// without eating horizontal space. Tagline appears in the option text so
// Daniel sees the trade-off when picking.
export function ModelSelector() {
  const { model, setModel } = useModelStore();

  return (
    <select
      value={model}
      onChange={(e) => setModel(e.target.value as ModelId)}
      title="Chat model"
      style={{
        fontSize: 11,
        fontFamily: FONT,
        fontWeight: 500,
        color: "#3C3C43",
        background: "rgba(0,0,0,0.04)",
        border: "1px solid rgba(0,0,0,0.10)",
        borderRadius: 6,
        padding: "3px 6px",
        cursor: "pointer",
        appearance: "none",
        WebkitAppearance: "none",
        outline: "none",
      }}
    >
      {MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} — {m.tagline}
        </option>
      ))}
    </select>
  );
}
