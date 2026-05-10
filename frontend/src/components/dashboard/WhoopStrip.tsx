import { useQuery } from "@tanstack/react-query";
import { Heart, Moon, Activity } from "lucide-react";
import {
  fetchWhoopStatus, fetchWhoopToday,
  type WhoopStatus, type WhoopToday,
} from "../../services/api";

// WhoopStrip — three slim cards above the focus row on the dashboard:
// Recovery / Sleep / Strain. Renders nothing when Whoop OAuth isn't
// connected so the strip doesn't add noise to fresh installs.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

function recoveryColor(score: number | null): string {
  if (score == null) return "#94A3B8";
  if (score >= 67) return "#22C55E";
  if (score >= 34) return "#F59E0B";
  return "#EF4444";
}

export function WhoopStrip() {
  const { data: status } = useQuery<WhoopStatus>({
    queryKey: ["whoop-status"],
    queryFn: fetchWhoopStatus,
  });

  const enabled = Boolean(status?.configured && status?.connected);

  const { data } = useQuery<WhoopToday>({
    queryKey: ["whoop-today"],
    queryFn: () => fetchWhoopToday(),
    enabled,
  });

  if (!enabled) return null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: 8,
      fontFamily: FONT,
      marginBottom: 12,
    }}>
      <Card
        icon={<Heart size={12} color={recoveryColor(data?.recovery_score ?? null)} strokeWidth={2} />}
        label="Recovery"
        value={data?.recovery_score != null ? `${data.recovery_score}%` : "—"}
        sub={data?.hrv_rmssd_ms != null ? `${Math.round(data.hrv_rmssd_ms)} ms HRV` : null}
        accent={recoveryColor(data?.recovery_score ?? null)}
      />
      <Card
        icon={<Moon size={12} color="#3B82F6" strokeWidth={2} />}
        label="Sleep"
        value={
          data?.sleep_minutes != null
            ? `${Math.floor(data.sleep_minutes / 60)}h ${data.sleep_minutes % 60}m`
            : "—"
        }
        sub={
          data?.sleep_performance_pct != null
            ? `${data.sleep_performance_pct}% of need`
            : null
        }
        accent="#3B82F6"
      />
      <Card
        icon={<Activity size={12} color="#A855F7" strokeWidth={2} />}
        label="Strain"
        value={data?.strain != null ? data.strain.toFixed(1) : "—"}
        sub={data?.resting_hr != null ? `${data.resting_hr} bpm RHR` : null}
        accent="#A855F7"
      />
    </div>
  );
}

function Card({ icon, label, value, sub, accent }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string | null;
  accent: string;
}) {
  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
      borderRadius: 10,
      padding: "8px 12px",
      display: "flex", flexDirection: "column", gap: 2,
      minHeight: 56,
      borderLeft: `2px solid ${accent}`,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
        letterSpacing: 0.3, textTransform: "uppercase",
      }}>
        {icon} {label}
      </div>
      <div style={{
        fontSize: 17, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)",
        fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}
