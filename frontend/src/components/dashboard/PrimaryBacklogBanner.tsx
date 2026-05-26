import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchPrimaryBacklog,
  fetchBacklogTickets,
  promoteBacklogToPrimary,
  clearPrimaryBacklog,
  updateBacklogTicket,
  type ApiBacklogTicket,
  type BoardStatus,
} from "../../services/api";
import { LiveTimer } from "./LiveTimer";
import { FONT, z } from "../../ui";


// Banner colors are vivid + saturated — this is the loudest surface on
// the dashboard on purpose ("this is your one north-star"). Status color
// floods the whole banner; the tonal label reads as a subtle in-bg chip
// (darker shade of the same hue) so the state info doesn't compete with
// the title.
const STATE_STYLE: Record<
  BoardStatus,
  { label: string; bg: string; tonal: string; titleColor: string }
> = {
  not_yet: {
    label: "not yet",
    bg: "#6366F1",        // indigo-500
    tonal: "#4338CA",     // indigo-700 (label blends darker into bg)
    titleColor: "#FFFFFF",
  },
  doing: {
    label: "doing",
    bg: "#F59E0B",        // amber-500
    tonal: "#B45309",     // amber-700
    titleColor: "#FFFFFF",
  },
  done: {
    label: "done",
    bg: "#10B981",        // emerald-500
    tonal: "#047857",     // emerald-700
    titleColor: "#FFFFFF",
  },
};

const CYCLE: Record<BoardStatus, BoardStatus> = {
  not_yet: "doing",
  doing: "done",
  done: "not_yet",
};

function currentStatus(t: ApiBacklogTicket): BoardStatus {
  if (t.done) return "done";
  if (t.board_status === "doing") return "doing";
  return "not_yet";
}

export function PrimaryBacklogBanner() {
  const qc = useQueryClient();
  const { data: ticket, isLoading } = useQuery<ApiBacklogTicket | null>({
    queryKey: ["primary-backlog"],
    queryFn: fetchPrimaryBacklog,
  });

  const [pickerOpen, setPickerOpen] = useState(false);

  function refresh() {
    qc.invalidateQueries({ queryKey: ["primary-backlog"] });
    // Banner state cycles also touch the underlying ticket's board_status —
    // keep the backlog board cache + dashboard counters in sync.
    qc.invalidateQueries({ queryKey: ["backlog-tickets"] });
  }

  async function cyclePillState() {
    if (!ticket) return;
    const next = CYCLE[currentStatus(ticket)];
    try {
      // Marking the ticket done also clears is_primary server-side (mirrors
      // Todo's done→clear-primary). The empty state then renders the picker.
      await updateBacklogTicket(ticket.id, {
        board_status: next,
        done: next === "done",
      });
      refresh();
    } catch (e) {
      console.error("Failed to cycle banner state", e);
    }
  }

  async function unpin() {
    try {
      await clearPrimaryBacklog();
      refresh();
    } catch (e) {
      console.error("Failed to unpin primary", e);
    }
  }

  async function pickTicket(id: number) {
    try {
      await promoteBacklogToPrimary(id);
      setPickerOpen(false);
      refresh();
    } catch (e) {
      console.error("Failed to set primary", e);
    }
  }

  if (isLoading) {
    // Render a sized placeholder so the layout doesn't jump when data lands.
    return <div style={{ height: 60, margin: "8px 0 14px" }} />;
  }

  if (!ticket) {
    return (
      <>
        <div
          style={{
            margin: "8px 0 14px",
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px dashed var(--gooni-border, rgba(0,0,0,0.12))",
            background: "var(--gooni-card, rgba(0,0,0,0.02))",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            fontFamily: FONT,
          }}
        >
          <div style={{ fontSize: 13, color: "var(--gooni-muted, #6E6E73)" }}>
            <span style={{ fontWeight: 600, color: "var(--gooni-text, #1C1C1E)" }}>
              No primary backlog set.
            </span>{" "}
            Pin one ticket to focus your build energy.
          </div>
          <button
            onClick={() => setPickerOpen(true)}
            style={{
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT,
              borderRadius: 8,
              border: "1px solid var(--gooni-border, rgba(0,0,0,0.1))",
              background: "var(--gooni-card, #fff)",
              color: "var(--gooni-text, #1C1C1E)",
              cursor: "pointer",
            }}
          >
            Pick from backlog →
          </button>
        </div>
        {pickerOpen && (
          <PrimaryPicker
            onPick={pickTicket}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </>
    );
  }

  const state = currentStatus(ticket);
  const palette = STATE_STYLE[state];

  return (
    <div
      style={{
        position: "relative",
        margin: "10px 0 18px",
        padding: "30px 56px",
        borderRadius: 16,
        background: palette.bg,
        fontFamily: FONT,
        // Subtle inner shadow gives the flat color slight depth without
        // breaking the "no edge stripe" rule — looks like solid paint, not
        // a card with a border.
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06), 0 6px 20px rgba(0,0,0,0.06)",
        textAlign: "center",
        // Smooth color transition when the pill cycles, so the whole
        // banner crossfades between status hues instead of snapping.
        transition: "background 280ms ease",
      }}
    >
      {/* Status label — top-left, small caps, blends into the bg via a
          darker shade of the same hue. Click to cycle. Daniel's "doing
          should blend with the actual color" ask. */}
      <button
        onClick={cyclePillState}
        title="Click to cycle: not yet → doing → done"
        style={{
          position: "absolute",
          top: 12,
          left: 16,
          padding: "3px 10px",
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 1.2,
          textTransform: "uppercase",
          color: palette.tonal,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: FONT,
        }}
      >
        {palette.label}
      </button>

      {/* Live timer — top-right, just inside the unpin button. Same
          shape as the primary-todo timer (Xs → Xm → Xh → Xd, capped).
          Anchored to ticket.created_at; semantics match the todo case
          (timer reads age of the ticket, not "time since promoted to
          primary"). On-color variant so the pill reads cleanly over
          the saturated banner background. */}
      <div style={{ position: "absolute", top: 14, right: 42 }}>
        <LiveTimer
          since={ticket.created_at}
          variant="onColor"
          title="Active on this banner"
        />
      </div>

      {/* Unpin — top-right, small, white. */}
      <button
        onClick={unpin}
        title="Unpin primary"
        style={{
          position: "absolute",
          top: 10,
          right: 12,
          width: 22,
          height: 22,
          padding: 0,
          fontSize: 12,
          lineHeight: 1,
          color: "#FFFFFF",
          opacity: 0.7,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          borderRadius: 4,
        }}
      >
        ✕
      </button>

      {/* The title — big, bold, centered. The only thing that actually
          matters on this surface; everything else recedes. */}
      <div
        style={{
          fontSize: 32,
          fontWeight: 800,
          letterSpacing: "-0.4px",
          lineHeight: 1.1,
          color: palette.titleColor,
          // Stop the title from getting clipped on tight widths — wrap
          // gracefully instead of ellipsizing (a banner this loud should
          // never truncate the one thing it's there to say).
          wordBreak: "break-word",
        }}
      >
        {ticket.text}
      </div>

      {/* Explicit transition row — done/cancel CTAs on-color so the user
          isn't forced to discover the small status pill or ✕ glyph. Done
          flips ticket → done (also auto-clears is_primary server-side via
          done cascade). Cancel unpins without touching board_status. */}
      {state !== "done" && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 10,
            marginTop: 22,
          }}
        >
          <button
            onClick={unpin}
            title="Unpin primary (ticket stays on board)"
            style={{
              padding: "7px 16px",
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: FONT,
              color: "#FFFFFF",
              background: "rgba(255,255,255,0.14)",
              border: "1px solid rgba(255,255,255,0.28)",
              borderRadius: 8,
              cursor: "pointer",
              transition: "background 0.12s, border-color 0.12s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.22)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.14)";
            }}
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              try {
                await updateBacklogTicket(ticket.id, { board_status: "done", done: true });
                refresh();
              } catch (e) {
                console.error("Failed to mark primary done", e);
              }
            }}
            title="Mark done — clears primary"
            style={{
              padding: "7px 18px",
              fontSize: 12.5,
              fontWeight: 700,
              fontFamily: FONT,
              color: palette.bg,
              background: "var(--gooni-card, #FFFFFF)",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              boxShadow: "0 2px 6px rgba(0,0,0,0.10)",
              transition: "transform 0.08s",
            }}
            onMouseDown={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.97)";
            }}
            onMouseUp={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
            }}
          >
            Mark done
          </button>
        </div>
      )}
    </div>
  );
}

// ── Picker ──────────────────────────────────────────────────────────────
//
// Lightweight inline modal listing every non-done backlog ticket. Click a
// row to set it as primary. v1 doesn't paginate — the open backlog is
// small enough that scrolling is fine; if it grows, add a filter input.

function PrimaryPicker({
  onPick,
  onClose,
}: {
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const { data: tickets } = useQuery<ApiBacklogTicket[]>({
    queryKey: ["backlog-tickets-open"],
    queryFn: () => fetchBacklogTickets(false),
  });

  const ref = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");

  // Escape + outside-click both close the picker — same affordance pattern
  // as ExploreModal / QuickNav so users don't have to learn new motions.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const list = tickets ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.text.toLowerCase().includes(q) ||
        (t.subtitle ?? "").toLowerCase().includes(q),
    );
  }, [tickets, query]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        zIndex: z.modalScrim,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        fontFamily: FONT,
      }}
    >
      <div
        ref={ref}
        style={{
          background: "var(--gooni-card, #fff)",
          color: "var(--gooni-text, #1C1C1E)",
          border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
          borderRadius: 14,
          width: "min(560px, 92vw)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--gooni-border, rgba(0,0,0,0.06))" }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            Pick your primary backlog ticket
          </div>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tickets…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              fontFamily: FONT,
              fontSize: 13,
              borderRadius: 8,
              border: "1px solid var(--gooni-border, rgba(0,0,0,0.1))",
              background: "var(--gooni-input-bg, #fff)",
              color: "var(--gooni-text, inherit)",
              outline: "none",
            }}
          />
        </div>
        <div style={{ overflowY: "auto", padding: "6px 6px 10px" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 22, textAlign: "center", color: "var(--gooni-muted, #8E8E93)", fontSize: 13 }}>
              No open backlog tickets.
            </div>
          ) : (
            filtered.map((t) => {
              const st = currentStatus(t);
              const pill = STATE_STYLE[st];
              return (
                <button
                  key={t.id}
                  onClick={() => onPick(t.id)}
                  style={{
                    display: "flex",
                    width: "100%",
                    textAlign: "left",
                    gap: 10,
                    alignItems: "center",
                    padding: "9px 12px",
                    borderRadius: 8,
                    border: "1px solid transparent",
                    background: "transparent",
                    cursor: "pointer",
                    fontFamily: FONT,
                    color: "inherit",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      "var(--gooni-hover, rgba(0,0,0,0.04))";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: pill.bg,
                      color: "#FFFFFF",
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.3,
                    }}
                  >
                    {pill.label}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 13.5,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {t.text}
                    </span>
                    {t.subtitle && (
                      <span
                        style={{
                          display: "block",
                          fontSize: 11.5,
                          color: "var(--gooni-muted, #8E8E93)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          marginTop: 1,
                        }}
                      >
                        {t.subtitle}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
