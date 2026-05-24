import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchHealthScores, type HealthScores, type HealthAxis,
} from "../../services/api";
import { HealthCard } from "./HealthCard";
import { HealthDrillDown } from "./HealthDrillDown";
import { FONT } from "../../ui";

// BuildMode — "Gooni Health" surface. 2-col grid of 6 axis cards.
// Click any → drill-down modal w/ component breakdown.


export function BuildMode() {
  const [drill, setDrill] = useState<HealthAxis | null>(null);
  const { data, isLoading } = useQuery<HealthScores>({
    queryKey: ["health-scores"],
    queryFn: fetchHealthScores,
    // Recompute every dashboard mount; refetchOnMount default.
    staleTime: 60_000,
  });

  const axes = data?.axes ?? [];

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{
        fontSize: 11, fontWeight: 500, color: "var(--gooni-muted, #8E8E93)",
        letterSpacing: 0.4, textTransform: "uppercase",
        marginBottom: 10, padding: "0 2px",
      }}>
        Gooni health
      </div>

      {isLoading ? (
        <div style={{
          padding: "20px 0", fontSize: 13,
          color: "var(--gooni-muted, #8E8E93)",
        }}>
          Computing scores…
        </div>
      ) : (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 10,
        }}>
          {axes.map((ax) => (
            <HealthCard key={ax.axis} axis={ax} onOpen={() => setDrill(ax)} />
          ))}
        </div>
      )}

      <HealthDrillDown axis={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
