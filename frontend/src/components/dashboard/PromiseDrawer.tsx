import { useEffect, useState } from "react";
import { Check, X, AlertTriangle } from "lucide-react";
import { color as ctok, FONT } from "../../ui";
import {
  fetchPromises,
  patchPromiseState,
  createPromise,
  type ApiPromise,
  type PromiseState,
} from "../../services/api";
import { parseServerDate } from "../../utils/date";
import { ItemCard, SectionHeader, AddItemRow, StatusDot } from "./TrackerPrimitives";
import { PromiseDetailModal } from "./PromiseDetailModal";

// Promise drawer — shares the todos card pattern (no outer section card,
// SectionHeader + AddItemRow + ItemCard rows). Two tabs: Active (closest-
// due first) and History (all, recency-sorted). Each active card has
// kept / broken quick actions; clicking the row opens PromiseDetailModal.
//
// G3.1 lifecycle: promises land `active` on create, resolve to `kept` or
// `broken`. The left glyph is a state-colored StatusDot (replaced the old
// vertical accent bar so it reads like the habit dot + todo checkbox).
const STATE_COLOR: Record<PromiseState, string> = {
  active: ctok.accent,
  kept: "#15803D",
  broken: "#B91C1C",
};

export function PromiseDrawer() {
  const [tab, setTab] = useState<"active" | "history">("active");
  const [active, setActive] = useState<ApiPromise[]>([]);
  const [history, setHistory] = useState<ApiPromise[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const [a, h] = await Promise.all([
        fetchPromises({ state: "active", limit: 50 }),
        fetchPromises({ limit: 50 }),
      ]);
      setActive(a);
      setHistory(h);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function transition(id: number, state: PromiseState) {
    // Optimistic: drop from the active list immediately so it feels
    // instant; reload picks up the server's resolved_at.
    setActive((prev) => prev.filter((p) => p.id !== id));
    try {
      await patchPromiseState(id, state);
    } finally {
      void reload();
    }
  }

  async function submitAdd(text: string) {
    await createPromise(text);
    setTab("active"); // jump to where the new promise lands
    await reload();
  }

  const rows = tab === "active" ? active : history;
  const openPromise = [...active, ...history].find((p) => p.id === openId) ?? null;

  return (
    <div style={{ fontFamily: FONT }}>
      <SectionHeader
        label="promises"
        onAdd={() => setAdding(true)}
        addTitle="Add a promise"
        rightExtra={
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {(["active", "history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  fontSize: 11, fontWeight: 600,
                  padding: "3px 10px", borderRadius: 999, border: "none",
                  background: tab === t ? "rgba(10,132,255,0.10)" : "transparent",
                  color: tab === t ? ctok.accent : "var(--gooni-muted, #8E8E93)",
                  cursor: "pointer", textTransform: "capitalize",
                }}
              >
                {t}
                {t === "active" && active.length > 0 && (
                  <span style={{ marginLeft: 4, fontWeight: 500 }}>· {active.length}</span>
                )}
              </button>
            ))}
          </div>
        }
      />

      {loading && rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", padding: "4px 2px" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", lineHeight: 1.5, padding: "4px 2px" }}>
          {tab === "active" ? (
            <>
              No active promises.
              <br />
              <span style={{ fontSize: 12 }}>
                Gooni captures these from chat — say "imma hit the gym tonight" — or
                hit <strong>+</strong> to add one.
              </span>
            </>
          ) : (
            "No history yet."
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {rows.map((p) => (
            <PromiseRow
              key={p.id}
              promise={p}
              showActions={tab === "active"}
              onOpen={() => setOpenId(p.id)}
              onTransition={transition}
            />
          ))}
        </div>
      )}

      <AddItemRow
        pill="promise"
        open={adding}
        onOpenChange={setAdding}
        placeholder="e.g. hit the gym tonight"
        onSubmit={(text) => void submitAdd(text)}
      />

      {openPromise && (
        <PromiseDetailModal
          promise={openPromise}
          onClose={() => setOpenId(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

function PromiseRow({
  promise,
  showActions,
  onOpen,
  onTransition,
}: {
  promise: ApiPromise;
  showActions: boolean;
  onOpen: () => void;
  onTransition: (id: number, state: PromiseState) => void;
}) {
  const dueLabel = formatDue(promise.inferred_due);
  const stateColor = STATE_COLOR[promise.state];
  const slipHigh = promise.slip_count >= 2;
  return (
    <ItemCard onClick={onOpen} style={{ alignItems: "flex-start" }}>
      <StatusDot color={stateColor} title={promise.state} size={8} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 500, color: "var(--gooni-text, #1C1C1E)",
          lineHeight: 1.4, overflow: "hidden",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        }}>
          {promise.summary || promise.utterance}
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginTop: 4,
          flexWrap: "wrap", fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
        }}>
          <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: stateColor }}>
            {promise.state}
          </span>
          {dueLabel && <span>· {dueLabel}</span>}
          {slipHigh && (
            <span
              title={`Daniel has slipped on similar promises ${promise.slip_count}× before`}
              style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#D97706" }}
            >
              <AlertTriangle size={11} strokeWidth={2.2} />
              slips ×{promise.slip_count}
            </span>
          )}
        </div>
      </div>
      {showActions && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <ActionBtn label="kept" color="#15803D" onClick={() => onTransition(promise.id, "kept")}>
            <Check size={13} strokeWidth={2.4} />
          </ActionBtn>
          <ActionBtn label="broken" color="#B91C1C" onClick={() => onTransition(promise.id, "broken")}>
            <X size={13} strokeWidth={2.4} />
          </ActionBtn>
        </div>
      )}
    </ItemCard>
  );
}

function ActionBtn({
  label,
  color,
  children,
  onClick,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`Mark ${label}`}
      style={{
        width: 24, height: 24, borderRadius: 6,
        border: "1px solid rgba(0,0,0,0.08)",
        background: "var(--gooni-card, #FFFFFF)",
        color, cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        padding: 0, transition: "background 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--gooni-card, #FFFFFF)"; }}
    >
      {children}
    </button>
  );
}

function formatDue(iso: string | null): string | null {
  const d = parseServerDate(iso);
  if (!d) return null;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const absHours = Math.abs(diffMs) / 36e5;
  if (diffMs < 0) {
    if (absHours < 24) return `overdue ${Math.round(absHours)}h`;
    return `overdue ${Math.round(absHours / 24)}d`;
  }
  if (absHours < 1) return `due in ${Math.round((diffMs / 1000) / 60)}m`;
  if (absHours < 24) return `due in ${Math.round(absHours)}h`;
  return `due in ${Math.round(absHours / 24)}d`;
}
