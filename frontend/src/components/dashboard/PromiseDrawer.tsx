import { useEffect, useRef, useState } from "react";
import { Check, X, AlertTriangle, Plus } from "lucide-react";
import { color as ctok, FONT } from "../../ui";
import {
  fetchPromises,
  patchPromiseState,
  createPromise,
  type ApiPromise,
  type PromiseState,
} from "../../services/api";
import { parseServerDate } from "../../utils/date";


// Promise drawer — dashboard widget that surfaces the `promises` table.
// Two tabs: Active (state=active, closest-due first), History (all,
// recency-sorted). Each active card has kept / broken actions. The "+"
// adds a promise directly (they usually arrive via chat utterances).
//
// G3.1 lifecycle: promises land `active` on create, resolve to `kept` or
// `broken`. The old proposed/pending lock-in + `abandoned` are gone — the
// active tab used to query the dead `pending` state, so it always read
// empty even with live promises.
export function PromiseDrawer() {
  const [tab, setTab] = useState<"active" | "history">("active");
  const [active, setActive] = useState<ApiPromise[]>([]);
  const [history, setHistory] = useState<ApiPromise[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  async function transition(id: number, state: PromiseState) {
    // Optimistic: drop the promise from the active list immediately so
    // the UX feels instant; reload to pick up server's resolved_at.
    setActive((prev) => prev.filter((p) => p.id !== id));
    try {
      await patchPromiseState(id, state);
    } finally {
      void reload();
    }
  }

  async function submitAdd() {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      await createPromise(text);
      setDraft("");
      setAdding(false);
      setTab("active"); // jump to where the new promise lands
      await reload();
    } finally {
      setSaving(false);
    }
  }

  const rows = tab === "active" ? active : history;

  return (
    <div
      style={{
        background: "var(--gooni-card, #FFFFFF)",
        border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 14,
        padding: 16,
        fontFamily: FONT,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "var(--gooni-muted, #8E8E93)",
          }}
        >
          Promises
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={() => setAdding((v) => !v)}
            title="Add a promise"
            aria-label="Add a promise"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: 999,
              border: "none",
              background: adding ? "rgba(10,132,255,0.10)" : "transparent",
              color: adding ? ctok.accent : "var(--gooni-muted, #8E8E93)",
              cursor: "pointer",
              marginRight: 2,
            }}
          >
            <Plus size={15} strokeWidth={2.4} />
          </button>
          {(["active", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "3px 10px",
                borderRadius: 999,
                border: "none",
                background: tab === t ? "rgba(10,132,255,0.10)" : "transparent",
                color: tab === t ? ctok.accent : "var(--gooni-muted, #8E8E93)",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t}
              {t === "active" && active.length > 0 && (
                <span style={{ marginLeft: 4, fontWeight: 500 }}>· {active.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {adding && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setDraft("");
              }
            }}
            placeholder="e.g. hit the gym tonight"
            style={{
              flex: 1,
              fontSize: 13,
              fontFamily: FONT,
              padding: "7px 10px",
              borderRadius: 8,
              border: "1px solid var(--gooni-border, rgba(0,0,0,0.12))",
              background: "var(--gooni-card, #FFFFFF)",
              color: "var(--gooni-text, #1C1C1E)",
              outline: "none",
            }}
          />
          <button
            onClick={() => void submitAdd()}
            disabled={!draft.trim() || saving}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "0 14px",
              borderRadius: 8,
              border: "none",
              background: !draft.trim() || saving ? "rgba(10,132,255,0.35)" : ctok.accent,
              color: "#FFFFFF",
              cursor: !draft.trim() || saving ? "default" : "pointer",
            }}
          >
            {saving ? "…" : "Add"}
          </button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", lineHeight: 1.5 }}>
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
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((p) => (
            <PromiseRow key={p.id} promise={p} showActions={tab === "active"} onTransition={transition} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PromiseRow({
  promise,
  showActions,
  onTransition,
}: {
  promise: ApiPromise;
  showActions: boolean;
  onTransition: (id: number, state: PromiseState) => void;
}) {
  const dueLabel = formatDue(promise.inferred_due);
  const stateAccent = STATE_ACCENT[promise.state];
  const slipHigh = promise.slip_count >= 2;
  return (
    <li
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--gooni-card-alt, rgba(0,0,0,0.02))",
      }}
    >
      <span
        style={{
          width: 4,
          alignSelf: "stretch",
          borderRadius: 2,
          background: stateAccent,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--gooni-text, #1C1C1E)",
            lineHeight: 1.4,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {promise.summary || promise.utterance}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 4,
            flexWrap: "wrap",
            fontSize: 11,
            color: "var(--gooni-muted, #8E8E93)",
          }}
        >
          <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: stateAccent }}>
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
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <ActionBtn label="kept" color="#15803D" onClick={() => onTransition(promise.id, "kept")}>
            <Check size={13} strokeWidth={2.4} />
          </ActionBtn>
          <ActionBtn label="broken" color="#B91C1C" onClick={() => onTransition(promise.id, "broken")}>
            <X size={13} strokeWidth={2.4} />
          </ActionBtn>
        </div>
      )}
    </li>
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
        width: 24,
        height: 24,
        borderRadius: 6,
        border: "1px solid rgba(0,0,0,0.08)",
        background: "var(--gooni-card, #FFFFFF)",
        color,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        transition: "background 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "var(--gooni-card, #FFFFFF)";
      }}
    >
      {children}
    </button>
  );
}

const STATE_ACCENT: Record<PromiseState, string> = {
  // G3.1 lifecycle: active | kept | broken.
  active: ctok.accent,
  kept: "#15803D",
  broken: "#B91C1C",
};

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
