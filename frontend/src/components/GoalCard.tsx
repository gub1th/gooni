import { Goal } from "../services/api";

interface Props {
  goal: Goal;
}

export function GoalCard({ goal }: Props) {
  return (
    <div
      style={{
        background: "#f7fafc",
        borderRadius: 8,
        padding: "10px 14px",
        minWidth: 130,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: "#4a5568",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 150,
        }}
      >
        {goal.title}
      </div>
      <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 2 }}>
        {goal.goal_type === "avoid" ? "avoid" : "achieve"}
      </div>
    </div>
  );
}
