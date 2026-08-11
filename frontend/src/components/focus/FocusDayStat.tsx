import { useCallback, useEffect, useState } from "react";
import { FONT } from "../../ui";
import { ink } from "../ambient/ambientInk";
import { fetchFocusTotals, fmtMinutes } from "../../services/focusTime";
import { useFocusSessionStore } from "../../stores/useFocusSessionStore";

// `focused today` — the day summary, value over label, in the corner cluster.
//
// It used to share its slot with the running session ("one slot, two states").
// Pass 3 split them: a running session is a MODE and reads as its own band at
// the top of the viewport (`FocusSessionBar`), while this stays what it always
// was — a quiet number about the day.
const POLL_MS = 30_000;

export function FocusDayStat() {
  const session = useFocusSessionStore((s) => s.session);
  const [today, setToday] = useState(0);

  const load = useCallback(async () => {
    try {
      setToday((await fetchFocusTotals()).today);
    } catch {
      /* ambient — the trackable may not exist yet, and 0 is honest */
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(iv);
  }, [load]);

  // A session ending writes its entry, so the day total moves the moment the
  // store drops back to null.
  useEffect(() => {
    if (session == null) void load();
  }, [session, load]);

  return (
    <div style={{ textAlign: "right", lineHeight: 1.15, fontFamily: FONT }}>
      <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "-0.01em", color: ink(0.92), fontVariantNumeric: "tabular-nums" }}>
        {fmtMinutes(today)}
      </div>
      <div style={{ fontSize: 10, letterSpacing: "0.02em", color: ink(0.38), marginTop: 2 }}>focused today</div>
    </div>
  );
}
