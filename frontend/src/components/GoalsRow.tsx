import { useGoalsStore } from "../stores/useGoalsStore";
import { GoalCard } from "./GoalCard";

export function GoalsRow() {
  const goals = useGoalsStore((s) => s.goals);

  if (goals.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        overflowX: "auto",
        paddingBottom: 4,
      }}
    >
      {goals.map((g) => (
        <GoalCard key={g.id} goal={g} />
      ))}
    </div>
  );
}
