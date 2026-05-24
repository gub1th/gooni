import { FONT } from "../../ui";

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
        color: "#3C3C43",
        fontFamily: FONT,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontWeight: 600 }}>{value}</span>
      <span style={{ color: "#8E8E93", marginLeft: 5 }}>{label}</span>
    </div>
  );
}
