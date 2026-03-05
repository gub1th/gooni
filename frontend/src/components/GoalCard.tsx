import { Goal } from "../services/api";

const SQUARE_SIZE = 8;
const SQUARE_GAP = 2;

interface Props {
  goal: Goal;
}

export function GoalCard({ goal }: Props) {
  const isAvoid = goal.goal_type === "avoid";
  const filledColor = isAvoid ? "#9f7aea" : "#48bb78";
  const emptyColor = "#e2e8f0";

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ display: "flex", gap: SQUARE_GAP }}>
          {goal.last_7_days.map((filled, i) => (
            <div
              key={i}
              style={{
                width: SQUARE_SIZE,
                height: SQUARE_SIZE,
                borderRadius: 2,
                background: filled ? filledColor : emptyColor,
              }}
            />
          ))}
        </div>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            color: goal.streak > 0 ? filledColor : "#a0aec0",
          }}
        >
          {goal.streak}d
        </span>
      </div>
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
    </div>
  );
}
