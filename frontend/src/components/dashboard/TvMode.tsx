import { useQuery } from "@tanstack/react-query";
import { FONT } from "../../ui";
import { WhoopSection, CutTableSection } from "../StatsView";
import {
  fetchTodos,
  fetchPromises,
  type ApiTodoBundle,
  type ApiPromise,
} from "../../services/api";

// TvMode — read-only ambient display, meant for a wall TV (but lives as a
// dashboard tab for now, per Daniel: additive, no kiosk route). Big fonts,
// no interaction. Auto-refreshes every 5 min so it stays live without a
// reload. Composes the existing Whoop + CutTable sections + big todo/promise
// panels.

const REFRESH_MS = 5 * 60_000;

export function TvMode() {
  const { data: todos } = useQuery<ApiTodoBundle>({
    queryKey: ["todos"],
    queryFn: fetchTodos,
    refetchInterval: REFRESH_MS,
  });
  const { data: promises = [] } = useQuery<ApiPromise[]>({
    queryKey: ["promises", "active"],
    queryFn: () => fetchPromises({ state: "active", limit: 10 }),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  const primary = todos?.primary ?? null;
  const open = todos?.open ?? [];

  return (
    <div style={{ fontFamily: FONT, color: "var(--gooni-text, #1C1C1E)" }}>
      {/* TODAY — todos */}
      <section style={{ marginBottom: 32 }}>
        <Heading>Today</Heading>
        {primary && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <span style={{ color: "var(--gooni-accent, #534AB7)", fontSize: 22 }}>●</span>
            <span style={{ fontSize: 26, fontWeight: 600 }}>{primary.text}</span>
          </div>
        )}
        {open.filter((t) => !t.is_primary).slice(0, 8).map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
            <span style={{
              color: t.state === "doing" ? "var(--gooni-accent, #534AB7)" : "var(--gooni-faint, #C7C7CC)",
              fontSize: 18,
            }}>○</span>
            <span style={{ fontSize: 20, color: "var(--gooni-text, #1C1C1E)" }}>
              {t.text}{t.state === "doing" ? "  ·  doing" : ""}
            </span>
          </div>
        ))}
        {!primary && open.length === 0 && (
          <div style={{ fontSize: 18, color: "var(--gooni-muted, #8E8E93)" }}>nothing on the plate.</div>
        )}
      </section>

      {/* PROMISES */}
      {promises.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <Heading>Promises</Heading>
          {promises.slice(0, 6).map((p) => (
            <div key={p.id} style={{ fontSize: 18, marginBottom: 6 }}>
              {p.summary || p.utterance}
              {p.slip_count > 0 && (
                <span style={{ color: "#C76B6B", fontSize: 14 }}>  ·  slipped {p.slip_count}×</span>
              )}
            </div>
          ))}
        </section>
      )}

      {/* The cut + recovery — reuse the existing sections (auto-refresh
          handled by their own queries / staleTime). */}
      <CutTableSection />
      <WhoopSection />
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase",
      color: "var(--gooni-muted, #8E8E93)", marginBottom: 14,
    }}>
      {children}
    </div>
  );
}
