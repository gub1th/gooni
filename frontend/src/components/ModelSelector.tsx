import { MODELS, useModelStore, type ModelId } from "../stores/useModelStore";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

export function ModelSelector() {
  const { model, setModel } = useModelStore();

  return (
    <div style={{ display: "flex", gap: 4 }}>
      {MODELS.map((m) => {
        const active = model === m.id;
        return (
          <button
            key={m.id}
            onClick={() => setModel(m.id as ModelId)}
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              border: active ? "1px solid rgba(0,0,0,0.2)" : "1px solid transparent",
              background: active ? "#1C1C1E" : "rgba(0,0,0,0.05)",
              color: active ? "#FFFFFF" : "#636366",
              fontSize: 11,
              fontFamily: FONT,
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 0.1s",
            }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
