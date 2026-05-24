import { HamsterWheel } from "./animations/HamsterWheel";
import { FONT } from "../ui";


interface NoteLoadingStateProps {
  /** Hide the meta-line shimmer (e.g. when caller has its own header). */
  hideMeta?: boolean;
  /** Override the chat-style HamsterWheel with a custom slot. */
  bodySlot?: React.ReactNode;
}

/**
 * Skeleton header (title + meta) plus chat-style HamsterWheel for the body.
 * Used on the public note detail page so navigation feels fast even on a
 * cold cache. Title pulses to telegraph "still arriving" without the screen
 * looking empty.
 */
export function NoteLoadingState({ hideMeta, bodySlot }: NoteLoadingStateProps) {
  return (
    <>
      <style>{`
        @keyframes nls-pulse {
          0%, 100% { background-color: rgba(0,0,0,0.06); }
          50%      { background-color: rgba(0,0,0,0.10); }
        }
        .nls-bar {
          border-radius: 6px;
          animation: nls-pulse 1.4s ease-in-out infinite;
        }
        @keyframes nls-fade {
          0%, 100% { opacity: 0.7; }
          50%      { opacity: 1; }
        }
      `}</style>
      <div className="nls-bar" style={{ height: 38, width: "78%", marginBottom: 14 }} />
      {!hideMeta && (
        <div style={{ display: "flex", gap: 8, marginBottom: 52 }}>
          <div className="nls-bar" style={{ height: 12, width: 70 }} />
          <div className="nls-bar" style={{ height: 12, width: 100 }} />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>
        {bodySlot ?? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <HamsterWheel size={48} />
            <span
              style={{
                fontSize: 13,
                color: "#9b9b9b",
                fontFamily: FONT,
                animation: "nls-fade 2.5s ease-in-out infinite",
              }}
            >
              loading...
            </span>
          </div>
        )}
      </div>
    </>
  );
}
