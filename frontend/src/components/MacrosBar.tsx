import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { fetchTodayMacros, type DailyMacros, type MacroItem } from "../services/api";

export interface MacrosBarHandle {
  refresh: () => void;
}

const MACROS = [
  { key: "calories" as const, label: "cal",     suffix: "",  color: "#111" },
  { key: "protein"  as const, label: "protein", suffix: "g", color: "#111" },
  { key: "carbs"    as const, label: "carbs",   suffix: "g", color: "#111" },
  { key: "fat"      as const, label: "fat",     suffix: "g", color: "#111" },
];

export const MacrosBar = forwardRef<MacrosBarHandle>((_, ref) => {
  const [data, setData] = useState<DailyMacros | null>(null);

  const load = () => fetchTodayMacros().then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  useImperativeHandle(ref, () => ({ refresh: load }));

  const t = data?.totals;
  const meals = data?.meals ?? [];
  const hasData = t && t.calories > 0;

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        background: "#fff",
        minHeight: 120,
      }}
    >
      {/* Left: macro totals */}
      <div
        style={{
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 10,
          borderRight: "1px solid #e5e7eb",
          minWidth: 110,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Today
        </div>
        {MACROS.map(({ key, label, suffix }) => (
          <div key={key}>
            <span style={{ fontSize: 18, fontWeight: 700, color: hasData ? "#111" : "#d1d5db" }}>
              {hasData ? `${Math.round(t![key])}${suffix}` : "—"}
            </span>
            <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Right: meal log */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {meals.length === 0 ? (
          <span style={{ fontSize: 13, color: "#9ca3af", margin: "auto 0" }}>
            Nothing logged yet
          </span>
        ) : (
          meals.map((meal, i) => (
            <div key={i}>
              {/* Meal header */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 5 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "capitalize" }}>
                  {meal.meal_type}
                </span>
                {meal.logged_at && (
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>
                    · {new Date(meal.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase()}
                  </span>
                )}
              </div>
              {/* Items */}
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {(meal.items ?? []).map((item: MacroItem, j: number) => (
                  <div key={j} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, color: "#374151" }}>{item.name}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap", marginLeft: 8 }}>
                      {[
                        item.calories != null && `${Math.round(item.calories)} cal`,
                        item.protein  != null && `${Math.round(item.protein)}g P`,
                      ].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
});
