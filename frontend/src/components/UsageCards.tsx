import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOpenAIUsage, fetchClaudeUsage } from "../services/api";
import { FONT } from "../ui";


type Provider = "openai" | "claude";

// Cards row: daily + monthly. Toggle in the section header flips between
// OpenAI ($) and Claude (tokens). Per-channel split (telegram/whatsapp/web)
// would need per-message cost persistence — flagged as schema-change work.
export function UsageCards() {
  const [provider, setProvider] = useState<Provider>("openai");

  const openai = useQuery({
    queryKey: ["openai-usage"],
    queryFn: () => fetchOpenAIUsage(false),
    enabled: provider === "openai",
    staleTime: 5 * 60 * 1000,
  });

  const claude = useQuery({
    queryKey: ["claude-usage", 30],
    queryFn: () => fetchClaudeUsage(30, false),
    enabled: provider === "claude",
    staleTime: 5 * 60 * 1000,
  });

  // Today key in UTC — matches what the backend serialises in `by_day`.
  const todayKey = useMemo(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }, []);

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8,
      }}>
        <div style={{
          fontSize: 11, color: "var(--gooni-muted, #8E8E93)", letterSpacing: 0.6,
          textTransform: "uppercase", fontWeight: 600, fontFamily: FONT,
        }}>
          usage
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center",
          background: "rgba(0,0,0,0.05)", borderRadius: 999, padding: 2, gap: 0,
        }}>
          {(["openai", "claude"] as const).map((p) => {
            const active = provider === p;
            return (
              <button
                key={p}
                onClick={() => setProvider(p)}
                style={{
                  padding: "3px 10px", borderRadius: 999,
                  border: "none", cursor: "pointer",
                  background: active ? "#1C1C1E" : "transparent",
                  color: active ? "#fff" : "#3C3C43",
                  fontFamily: FONT, fontSize: 11, fontWeight: 600,
                  letterSpacing: 0.2,
                  transition: "background 0.12s, color 0.12s",
                  textTransform: "capitalize",
                }}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {provider === "openai" ? (
          <>
            <UsageCard
              label="today"
              primary={
                openai.isLoading
                  ? "…"
                  : openai.data?.configured
                    ? formatUsd(openai.data?.spend_today_usd ?? 0)
                    : "—"
              }
              sub={openai.data?.configured ? "OpenAI spend" : "OPENAI_ADMIN_KEY missing"}
            />
            <UsageCard
              label="this month"
              primary={
                openai.isLoading
                  ? "…"
                  : openai.data?.configured
                    ? formatUsd(openai.data?.spend_usd ?? 0)
                    : "—"
              }
              sub={openai.data?.configured ? "OpenAI spend" : ""}
            />
          </>
        ) : (
          <>
            <UsageCard
              label="today"
              primary={
                claude.isLoading
                  ? "…"
                  : claude.data?.available
                    ? formatTokens(sumTodayTokens(claude.data?.by_day, todayKey))
                    : "—"
              }
              sub={claude.data?.available ? "Claude tokens" : "no Claude usage uploaded"}
            />
            <UsageCard
              label="this month"
              primary={
                claude.isLoading
                  ? "…"
                  : claude.data?.available
                    ? formatTokens((claude.data?.input_tokens ?? 0) + (claude.data?.output_tokens ?? 0))
                    : "—"
              }
              sub={claude.data?.available ? "Claude tokens (30d)" : ""}
            />
          </>
        )}
      </div>
    </div>
  );
}

function UsageCard({ label, primary, sub }: { label: string; primary: string; sub?: string }) {
  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "1px solid var(--gooni-border, rgba(0,0,0,0.07))",
      borderRadius: 10, padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 3,
      minHeight: 70,
    }}>
      <div style={{ fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)", letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 600, fontFamily: FONT }}>
        {label}
      </div>
      <div style={{ fontSize: 19, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)", fontFamily: FONT, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
        {primary}
      </div>
      {sub && (
        <div style={{ fontSize: 10.5, color: "#AEAEB2", fontFamily: FONT, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function formatUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 10) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function sumTodayTokens(byDay: { date: string; input: number; output: number }[] | undefined, todayKey: string): number {
  if (!byDay) return 0;
  const row = byDay.find((d) => d.date === todayKey);
  return row ? row.input + row.output : 0;
}
