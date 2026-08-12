import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { FONT, frostInk } from "../../ui";
import { ink } from "../ambient/ambientInk";
import { useSessionEndOfferStore, type SessionEndOffer } from "../../stores/useSessionEndOfferStore";
import { updateFocusReminder } from "../../services/api";

// "mark kept" — OFFERED at the moment you stop, never performed for you.
//
// See `useSessionEndOfferStore` for why: stopping and finishing are different
// events, and auto-completing would make it impossible to stop without lying
// about the work. Taking this completes the task; ignoring it ends the session
// and leaves the task open.
//
// It expires on its own so it cannot become furniture — it is about the moment
// you stopped, and a minute later it is not that moment any more.
const OFFER_MS = 15_000;

export function MarkKeptOffer({
  onKept,
}: {
  /** the host retains the row so it stays struck through IN PLACE */
  onKept?: (offer: SessionEndOffer) => void;
}) {
  const offer = useSessionEndOfferStore((s) => s.offer);
  const clear = useSessionEndOfferStore((s) => s.clear);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!offer) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => clear(), OFFER_MS);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [offer, clear]);

  if (!offer) return null;

  async function take() {
    if (!offer || busy) return;
    setBusy(true);
    try {
      await updateFocusReminder(offer.promiseId, { state: "kept" });
      onKept?.(offer);
      clear();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", gap: 10, fontFamily: FONT,
        fontSize: 12.5, color: ink(0.6), whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: "24ch" }}>
        stopped · {offer.title}
      </span>
      <button
        onClick={() => void take()}
        disabled={busy}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          border: `1px solid ${frostInk.accent}`, borderRadius: 999,
          background: "transparent", cursor: busy ? "default" : "pointer",
          padding: "3px 10px", fontFamily: FONT, fontSize: 11.5, color: frostInk.accent,
        }}
      >
        <Check size={11} strokeWidth={2.6} />
        mark kept
      </button>
      <button
        onClick={() => clear()}
        aria-label="Leave the task open"
        title="leave it open"
        style={{
          width: 20, height: 20, padding: 0, borderRadius: 999, border: "none",
          background: "transparent", cursor: "pointer", color: ink(0.38),
          display: "grid", placeItems: "center",
        }}
      >
        <X size={12} strokeWidth={1.9} />
      </button>
    </div>
  );
}
