import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { fetchGooniTake, type GooniTakePayload } from "../../services/api";
import { FONT } from "../../ui";

// TakeTabs — single card at the TOP of the dashboard. Used to be a dev
// take / focus take tab toggle; collapsed down to just the focus take
// per Daniel's ask 2026-05-18. The dev take still exists in the API +
// StatsView surface, just not here. Sparkle icon now sits inline with
// the subtitle (no tab row above it).
//
// Take rows live in `gooni_takes` server-side (one row per UTC day per
// kind); fetching is a cheap DB read after first generation.


const QUESTION = "What are my current focuses?";
const EMPTY_HINT = "Write a few notes — Gooni needs material to read.";

export function TakeTabs() {
  const { data: take } = useQuery<GooniTakePayload>({
    queryKey: ["focus-take"],
    queryFn: () => fetchGooniTake(),
    staleTime: 30 * 60_000,
  });

  return (
    <div
      style={{
        background: "var(--gooni-card, #FFFFFF)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 12,
        padding: "12px 16px 14px",
        fontFamily: FONT,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
          color: "var(--gooni-muted, #8E8E93)",
        }}
      >
        <Sparkles size={13} strokeWidth={1.8} />
        <span
          style={{
            fontSize: 11.5,
            letterSpacing: 0.3,
            textTransform: "uppercase",
          }}
        >
          {QUESTION}
        </span>
      </div>

      {!take?.take ? (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--gooni-muted, #8E8E93)",
            fontStyle: "italic",
          }}
        >
          {EMPTY_HINT}
        </div>
      ) : (
        <div
          style={{
            fontSize: 13.5,
            color: "var(--gooni-text, #1C1C1E)",
            lineHeight: 1.55,
          }}
        >
          {take.take}
        </div>
      )}
    </div>
  );
}
