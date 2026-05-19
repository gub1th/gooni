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

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Mirrors BacklogBoard's column palette so the banner state pill reads the
// same color language as the kanban Daniel just came from.
const STATE_STYLE: Record<BoardStatus, { label: string; tint: string; bg: string }> = {
  not_yet: { label: "not yet", tint: "#94A3B8", bg: "rgba(148,163,184,0.14)" },
  doing:   { label: "doing",   tint: "#F59E0B", bg: "rgba(245,158,11,0.14)" },
  done:    { label: "done",    tint: "#16A34A", bg: "rgba(22,163,74,0.14)" },
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
  const pill = STATE_STYLE[state];

  return (
    <div
      style={{
        margin: "8px 0 14px",
        padding: "14px 16px",
        borderRadius: 12,
        // Subtle north-star vibe: thin amber accent stripe along the left
        // edge, faint card background. Distinct from regular content blocks
        // without being loud.
        background: "var(--gooni-card, #fff)",
        border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
        boxShadow: "inset 3px 0 0 #F59E0B",
        display: "flex",
        alignItems: "center",
        gap: 14,
        fontFamily: FONT,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "#F59E0B",
            fontWeight: 700,
            marginBottom: 3,
          }}
        >
          Primary focus
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--gooni-text, #1C1C1E)",
            lineHeight: 1.3,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {ticket.text}
        </div>
        {ticket.subtitle && (
          <div
            style={{
              fontSize: 12,
              color: "var(--gooni-muted, #6E6E73)",
              marginTop: 2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {ticket.subtitle}
          </div>
        )}
      </div>

      <button
        onClick={cyclePillState}
        title="Click to cycle: not yet → doing → done"
        style={{
          padding: "5px 12px",
          borderRadius: 999,
          background: pill.bg,
          color: pill.tint,
          fontSize: 11.5,
          fontWeight: 700,
          fontFamily: FONT,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          border: `1px solid ${pill.tint}33`,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {pill.label}
      </button>

      <button
        onClick={unpin}
        title="Unpin primary (banner returns to empty state)"
        style={{
          padding: "4px 8px",
          fontSize: 14,
          lineHeight: 1,
          color: "var(--gooni-muted, #8E8E93)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          borderRadius: 6,
        }}
      >
        ✕
      </button>
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
        zIndex: 4000,
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
                      color: pill.tint,
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
