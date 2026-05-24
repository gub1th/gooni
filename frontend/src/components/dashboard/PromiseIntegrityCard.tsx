import { useEffect, useState } from "react";
import { Shield, Flame, AlertTriangle } from "lucide-react";
import { FONT } from "../../ui";
import {
  fetchPromiseIntegrity,
  type PromiseIntegrity,
} from "../../services/api";


// PromiseIntegrityCard — Daniel's accountability scoreboard.
//
// Three numbers, loud and proud. % score (weighted rolling avg over last
// 20 resolved promises, asymmetric weights so broken stings more than
// kept rewards), current kept-streak (consecutive `kept` walking back),
// and last broken summary (so the most recent failure has a face).
//
// Daniel wanted this "loud and proud" — sits above PromiseDrawer in
// Today mode so it's the first promise-related surface he sees. Small-N
// degrades to a "not enough data yet" placeholder rather than a noisy
// score that swings 30% on one outcome.
export function PromiseIntegrityCard() {
  const [data, setData] = useState<PromiseIntegrity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchPromiseIntegrity()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return null; // Stay quiet until the first render lands.
  }

  if (!data) {
    return null; // Backend down — drawer below still works; don't shout.
  }

  if (data.score === null) {
    return (
      <Shell>
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
          Promise integrity — not enough data yet ({data.sample_size}/
          {data.min_sample} resolved).
        </div>
      </Shell>
    );
  }

  const tone = scoreTone(data.score);
  const lastBrokenRel = data.last_broken_at ? formatRel(data.last_broken_at) : null;

  return (
    <Shell accent={tone.accent}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 140 }}>
          <Shield size={22} strokeWidth={1.8} color={tone.accent} />
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--gooni-muted, #8E8E93)",
              }}
            >
              Promise integrity
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: tone.accent, lineHeight: 1 }}>
                {data.score}
              </span>
              <span style={{ fontSize: 14, color: "var(--gooni-muted, #8E8E93)" }}>
                %
              </span>
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 11,
                  color: "var(--gooni-muted, #8E8E93)",
                }}
              >
                last {data.sample_size}
              </span>
            </div>
          </div>
        </div>

        <Divider />

        <Stat
          icon={<Flame size={16} strokeWidth={2} color={data.kept_streak > 0 ? "#F97316" : "var(--gooni-muted, #8E8E93)"} />}
          label="kept streak"
          value={`${data.kept_streak}`}
        />

        {data.last_broken_summary && lastBrokenRel && (
          <>
            <Divider />
            <Stat
              icon={<AlertTriangle size={16} strokeWidth={2} color="#B91C1C" />}
              label="last broken"
              value={lastBrokenRel}
              hint={data.last_broken_summary}
            />
          </>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <div
      style={{
        background: "var(--gooni-card, #FFFFFF)",
        border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderLeft: accent ? `3px solid ${accent}` : undefined,
        borderRadius: 14,
        padding: 14,
        fontFamily: FONT,
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        alignSelf: "stretch",
        background: "rgba(0,0,0,0.08)",
        margin: "0 4px",
      }}
    />
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8 }}
      title={hint}
    >
      {icon}
      <div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--gooni-muted, #8E8E93)",
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)" }}>
          {value}
        </div>
      </div>
    </div>
  );
}

function scoreTone(score: number): { accent: string } {
  // Three bands. 0-49 = struggling (red), 50-74 = recovering (amber),
  // 75-100 = solid (green). Asymmetric weights mean 50% isn't "fine" —
  // it requires roughly 60% kept rate to break even, so 50%
  // already means more broken than kept.
  if (score >= 75) return { accent: "#15803D" };
  if (score >= 50) return { accent: "#D97706" };
  return { accent: "#B91C1C" };
}

function formatRel(iso: string): string {
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diffMs / 3_600_000));
    return `${hours}h ago`;
  }
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
