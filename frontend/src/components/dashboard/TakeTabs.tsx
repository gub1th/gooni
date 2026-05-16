import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Hammer } from "lucide-react";
import {
  fetchGooniTake, fetchDevTake, parseDevTake,
  type GooniTakePayload,
} from "../../services/api";

// TakeTabs — single card mounted at the TOP of the dashboard. Two tabs in
// the top-left: Sparkle = focus take ("what are my current focuses?"),
// Hammer = dev take ("what did I ship this week?"). Each take is
// persisted in `gooni_takes` server-side (one row per UTC day per kind);
// fetching is a cheap DB read after first generation.
//
// Dev take is now WEEKLY (take_service v2 prompt) — title reflects that.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

type Tab = "focus" | "dev";

const TAB_META: Record<Tab, { question: string; emptyHint: string }> = {
  focus: {
    question: "What are my current focuses?",
    emptyHint: "Write a few notes — Gooni needs material to read.",
  },
  dev: {
    question: "What did I ship this week?",
    emptyHint: "No commits in the last 7 days. (Or no tracked repos yet — Settings → Integrations → GitHub.)",
  },
};

export function TakeTabs() {
  const [tab, setTab] = useState<Tab>("focus");

  const { data: focusTake } = useQuery<GooniTakePayload>({
    queryKey: ["focus-take"],
    queryFn: () => fetchGooniTake(),
    staleTime: 30 * 60_000,
  });
  const { data: devTake } = useQuery<GooniTakePayload>({
    queryKey: ["dev-take"],
    queryFn: () => fetchDevTake(),
    staleTime: 30 * 60_000,
  });

  const active = tab === "focus" ? focusTake : devTake;
  const meta = TAB_META[tab];

  return (
    <div style={{
      background: "var(--gooni-card, #FFFFFF)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
      borderRadius: 12,
      padding: "12px 16px 14px",
      fontFamily: FONT,
      marginBottom: 16,
    }}>
      {/* Tab strip top-left. Icon-only — same affordance as the mockup,
          no labels until hover (fine; both icons are recognizable). */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
        <TabButton active={tab === "focus"} onClick={() => setTab("focus")} title="Current focuses">
          <Sparkles size={14} color={tab === "focus" ? "#1C1C1E" : "#9CA3AF"} strokeWidth={1.8} />
        </TabButton>
        <TabButton active={tab === "dev"} onClick={() => setTab("dev")} title="What I shipped this week">
          <Hammer size={14} color={tab === "dev" ? "#1C1C1E" : "#9CA3AF"} strokeWidth={1.8} />
        </TabButton>
      </div>

      {/* Question header — drives intent context for the take below. */}
      <div style={{
        fontSize: 11.5, color: "var(--gooni-muted, #8E8E93)",
        letterSpacing: 0.3, textTransform: "uppercase",
        marginBottom: 6,
      }}>
        {meta.question}
      </div>

      {/* Body. Dev take is rendered as themed bullets when the row is v3
          JSON; legacy v2 paragraph rows fall through to plain-text. */}
      {!active?.take ? (
        <div style={{
          fontSize: 12.5, color: "var(--gooni-muted, #8E8E93)",
          fontStyle: "italic",
        }}>
          {meta.emptyHint}
        </div>
      ) : tab === "dev" ? (
        <DevTakeBody raw={active.take} />
      ) : (
        <div style={{
          fontSize: 13.5, color: "var(--gooni-text, #1C1C1E)",
          lineHeight: 1.55,
        }}>
          {active.take}
        </div>
      )}
    </div>
  );
}

function DevTakeBody({ raw }: { raw: string }) {
  const view = parseDevTake(raw);
  if (view.kind === "empty") return null;
  if (view.kind === "text") {
    return (
      <div style={{
        fontSize: 13.5, color: "var(--gooni-text, #1C1C1E)",
        lineHeight: 1.55,
      }}>
        {raw}
      </div>
    );
  }
  return (
    <ul style={{
      margin: 0, padding: 0, listStyle: "none",
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      {view.themes.map((t) => (
        <li key={t.theme} style={{
          display: "flex", gap: 10, alignItems: "baseline",
          fontSize: 13.5, lineHeight: 1.5,
        }}>
          <span style={{
            flexShrink: 0,
            fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
            color: "var(--gooni-text, #1C1C1E)",
            background: "rgba(0,0,0,0.05)",
            padding: "2px 8px", borderRadius: 99,
          }}>
            {t.theme}
          </span>
          <span style={{ color: "var(--gooni-text, #3A3A3C)" }}>
            {t.summary}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TabButton({ active, onClick, title, children }: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      aria-label={title}
      style={{
        width: 28, height: 28,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        border: "none", background: active ? "rgba(0,0,0,0.05)" : "transparent",
        borderRadius: 6, cursor: "pointer",
        transition: "background 0.12s",
      }}
    >
      {children}
    </button>
  );
}
