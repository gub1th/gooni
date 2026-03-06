import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { CaptureBar } from "../components/CaptureBar";
import { GoalsRow } from "../components/GoalsRow";
import { Feed } from "../components/Feed";
import { MacrosBar } from "../components/MacrosBar";
import { WorkoutBar } from "../components/WorkoutBar";
import { useGoalsStore } from "../stores/useGoalsStore";
import { useFeedStore } from "../stores/useFeedStore";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const fetchGoals = useGoalsStore((s) => s.fetch);
  const fetchFeed = useFeedStore((s) => s.fetch);
  const macrosRef = useRef<{ refresh: () => void } | null>(null);
  const workoutRef = useRef<{ refresh: () => void } | null>(null);

  useEffect(() => {
    fetchGoals();
    fetchFeed();
  }, [fetchGoals, fetchFeed]);

  return (
    <div
      style={{
        maxWidth: 680,
        margin: "0 auto",
        padding: "40px 24px",
        fontFamily: "Inter, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <CaptureBar onSent={() => { macrosRef.current?.refresh(); workoutRef.current?.refresh(); }} />
      <Feed />
      <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: 0 }} />
      <GoalsRow />
      <MacrosBar ref={macrosRef} />
      <WorkoutBar ref={workoutRef} />
    </div>
  );
}
