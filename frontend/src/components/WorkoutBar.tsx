import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { fetchTodayWorkout, type DailyWorkout, type WorkoutSetEntry } from "../services/api";

export interface WorkoutBarHandle {
  refresh: () => void;
}

export const WorkoutBar = forwardRef<WorkoutBarHandle>((_, ref) => {
  const [data, setData] = useState<DailyWorkout | null>(null);

  const load = () => fetchTodayWorkout().then(setData).catch(() => {});
  useEffect(() => { load(); }, []);
  useImperativeHandle(ref, () => ({ refresh: load }));

  const hasData = data && data.workouts.length > 0;

  const fmt = (s: WorkoutSetEntry) => {
    const parts = [];
    if (s.sets && s.reps) parts.push(`${s.sets}×${s.reps}`);
    if (s.weight) parts.push(`@ ${s.weight}${s.weight_unit}`);
    return parts.join(" ");
  };

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        background: "#fff",
        minHeight: 100,
      }}
    >
      {/* Left: summary stats */}
      <div
        style={{
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 10,
          borderRight: "1px solid #e5e7eb",
          minWidth: 110,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Workout
        </div>
        <div>
          <span style={{ fontSize: 18, fontWeight: 700, color: hasData ? "#111" : "#d1d5db" }}>
            {hasData ? data.total_exercises : "—"}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>exercises</span>
        </div>
        <div>
          <span style={{ fontSize: 18, fontWeight: 700, color: hasData ? "#111" : "#d1d5db" }}>
            {hasData ? data.total_sets : "—"}
          </span>
          <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>sets</span>
        </div>
        {data?.total_duration ? (
          <div>
            <span style={{ fontSize: 18, fontWeight: 700, color: "#111" }}>{data.total_duration}</span>
            <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>min</span>
          </div>
        ) : null}
      </div>

      {/* Right: exercise list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {!hasData ? (
          <span style={{ fontSize: 13, color: "#9ca3af", margin: "auto 0" }}>Nothing logged yet</span>
        ) : (
          data.workouts.map((workout) => (
            <div key={workout.id}>
              {workout.logged_at && (
                <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6 }}>
                  {new Date(workout.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase()}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {workout.sets.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 13, color: "#374151" }}>{s.exercise}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{fmt(s)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
});
