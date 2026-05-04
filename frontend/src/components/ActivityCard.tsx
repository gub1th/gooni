import { FocusFlow } from "./FocusFlow";

// ActivityCard is the dashboard slot that historically rendered the
// focuses block. After the focus-flow redesign the whole module moved
// into FocusFlow — this file is now a thin shim so Dashboard.tsx's
// import path stays stable.
export function ActivityCard() {
  return (
    <div style={{ marginBottom: 16 }}>
      <FocusFlow />
    </div>
  );
}
