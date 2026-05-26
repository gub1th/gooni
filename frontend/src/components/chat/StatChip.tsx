import { color as ctok, FONT } from "../../ui";

interface StatChipProps {
  label: string;
  value: string | number;
}

export function StatChip({ label, value }: StatChipProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "5px 12px",
        borderRadius: 20,
        background: "rgba(0,0,0,0.05)",
        fontSize: 13,
        color: "var(--gooni-text, #3C3C43)",
        fontFamily: FONT,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontWeight: 600 }}>{value}</span>
      <span style={{ color: ctok.muted, marginLeft: 5 }}>{label}</span>
    </div>
  );
}
