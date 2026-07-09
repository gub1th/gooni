import { FONT } from "../ui";
import { CutTableSection, LeetcodeSection, WhoopSection } from "./StatsView";

// Slice 7 stats-lite — the surviving numbers after the dashboard kill:
// the cut grid (editable — Daniel is mid-cut, cell edits + backfill must
// keep working), Whoop, and LeetCode. All three read Trackable-backed
// APIs. Reachable from the sidebar's Stats row (?view=stats).
export function StatsLite() {
  return (
    <div
      style={{
        fontFamily: FONT,
        height: "100%",
        overflowY: "auto",
        padding: "28px 24px 48px",
        background: "var(--gooni-bg, #FFFFFF)",
      }}
    >
      <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, letterSpacing: 1.2,
          textTransform: "uppercase", color: "var(--gooni-muted, #8E8E93)",
        }}>
          stats
        </div>
        <CutTableSection editable />
        <WhoopSection />
        <LeetcodeSection />
      </div>
    </div>
  );
}
