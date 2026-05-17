import { useQuery } from "@tanstack/react-query";
import {
  fetchWhoopStatus, fetchWhoopToday,
  type WhoopStatus, type WhoopToday,
  type DashboardStats,
} from "../../services/api";
import { NeuralBrain } from "../animations/NeuralBrain";

// DashboardHeader — the top band of the dashboard. Greeting + date on
// the left; on the right: inline Whoop stats (recovery / sleep / strain
// — only when Whoop is connected) + a day-streak tile with a divider.
//
// Pulled from the prior layout where Whoop lived as its own card strip
// below the composer; consolidating into the header tightens the
// fold-of-the-page real estate without dropping any data.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

function recoveryColor(score: number | null): string {
  if (score == null) return "var(--gooni-muted, #8E8E93)";
  if (score >= 67) return "#0F6E56";
  if (score >= 34) return "#BA7517";
  return "#791F1F";
}

function fmtSleep(min: number | null | undefined): string {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function DashboardHeader({
  stats,
  onBrainClick,
}: {
  stats: DashboardStats | undefined;
  onBrainClick: () => void;
}) {
  const { data: whoopStatus } = useQuery<WhoopStatus>({
    queryKey: ["whoop-status"],
    queryFn: fetchWhoopStatus,
  });
  const whoopEnabled = Boolean(whoopStatus?.configured && whoopStatus?.connected);

  const { data: whoop } = useQuery<WhoopToday>({
    queryKey: ["whoop-today"],
    queryFn: () => fetchWhoopToday(),
    enabled: whoopEnabled,
  });

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16, fontFamily: FONT,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 28, fontWeight: 700, color: "var(--gooni-text, #1C1C1E)",
          letterSpacing: "-0.5px", lineHeight: 1.2,
        }}>
          {getGreeting()}, Daniel.
        </div>
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", marginTop: 4 }}>
          {getDateStr()}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <NeuralBrain size={56} onClick={onBrainClick} />

        {whoopEnabled ? (
          <div style={{ display: "flex", gap: 14 }}>
            <Stat
              value={
                whoop?.recovery_score != null ? `${whoop.recovery_score}%` : "—"
              }
              label="recovery"
              color={recoveryColor(whoop?.recovery_score ?? null)}
            />
            <Stat
              value={fmtSleep(whoop?.sleep_minutes)}
              label="sleep"
              color="var(--gooni-text, #1C1C1E)"
            />
            <Stat
              value={whoop?.strain != null ? whoop.strain.toFixed(1) : "—"}
              label="strain"
              color="#BA7517"
            />
          </div>
        ) : null}

        <div style={{
          borderLeft: "0.5px solid rgba(0,0,0,0.12)",
          paddingLeft: 14,
          textAlign: "center",
        }}>
          <div style={{
            fontSize: 18, fontWeight: 600,
            color: "var(--gooni-text, #1C1C1E)",
            fontVariantNumeric: "tabular-nums", lineHeight: 1,
          }}>
            {stats?.streak ?? "—"}
          </div>
          <div style={{
            fontSize: 9, color: "var(--gooni-muted, #8E8E93)",
            textTransform: "lowercase", marginTop: 2,
          }}>
            streak
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, color }: {
  value: string; label: string; color: string;
}) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{
        fontSize: 16, fontWeight: 600, color,
        fontVariantNumeric: "tabular-nums", lineHeight: 1,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 9, color: "var(--gooni-muted, #8E8E93)",
        marginTop: 2, textTransform: "lowercase",
      }}>
        {label}
      </div>
    </div>
  );
}
