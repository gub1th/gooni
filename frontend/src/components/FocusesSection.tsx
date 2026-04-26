import { useEffect, useMemo, useState } from "react";
import { useFocusesStore } from "../stores/useFocusesStore";
import {
  suggestFocuses,
  type ApiFocus,
  type ApiFocusSuggestion,
  type FocusStatus,
} from "../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

// Activity-derived display badge — separate from persisted `status`
// (committed/pending/someday/done). Drives the colored chip + the
// "no activity in X days" nudge.
type ActivityBadge = "on_it" | "inconsistent" | "neglected" | "new";

function computeBadge(f: ApiFocus): ActivityBadge {
  const now = Date.now();
  const created = f.created_at ? new Date(f.created_at).getTime() : now;
  const daysSinceCreated = (now - created) / 86400000;
  if (daysSinceCreated < 3 && !f.last_activity_at) return "new";

  if (!f.last_activity_at) return "neglected";
  const days = (now - new Date(f.last_activity_at).getTime()) / 86400000;
  if (days <= 3) return "on_it";
  if (days <= 10) return "inconsistent";
  return "neglected";
}

function ageLabel(f: ApiFocus): string {
  if (f.last_activity_at) {
    const days = Math.floor(
      (Date.now() - new Date(f.last_activity_at).getTime()) / 86400000,
    );
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    return `${days}d ago`;
  }
  if (f.created_at) {
    const minsAgo = (Date.now() - new Date(f.created_at).getTime()) / 60000;
    if (minsAgo < 60) return "just now";
  }
  return "no activity yet";
}

const BADGE_STYLE: Record<
  ActivityBadge,
  { bg: string; fg: string; border?: string }
> = {
  on_it:        { bg: "#DCFCE7", fg: "#166534" },
  inconsistent: { bg: "#FEF9C3", fg: "#854D0E" },
  neglected:    { bg: "#F2F2F7", fg: "#8E8E93", border: "rgba(0,0,0,0.08)" },
  new:          { bg: "#F2F2F7", fg: "#8E8E93", border: "rgba(0,0,0,0.08)" },
};

const BADGE_LABEL: Record<ActivityBadge, string> = {
  on_it: "on it",
  inconsistent: "inconsistent",
  neglected: "neglected",
  new: "new",
};

// Casual emoji guesser for suggestion cards. The LLM doesn't pick — quick
// keyword match keeps the prompt cheap and the visuals consistent.
function suggestionEmoji(name: string): string {
  const n = name.toLowerCase();
  if (/(job|career|startup|work|hire)/.test(n)) return "💼";
  if (/(gym|fit|abs|run|lift|health|body)/.test(n)) return "🏋️";
  if (/(ship|build|app|mvp|product|launch|gooni)/.test(n)) return "🛠️";
  if (/(read|book|learn|study)/.test(n)) return "📚";
  if (/(write|essay|blog|post)/.test(n)) return "✍️";
  if (/(money|save|invest|finance)/.test(n)) return "💰";
  if (/(faith|pray|god|spirit)/.test(n)) return "✨";
  if (/(travel|trip|move)/.test(n)) return "✈️";
  return "✦";
}

export function FocusesSection() {
  const { focuses, loaded, fetch, create, update, remove, heartbeat } =
    useFocusesStore();

  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftEndgoal, setDraftEndgoal] = useState("");
  const [draftDue, setDraftDue] = useState("");
  const [draftStatus, setDraftStatus] = useState<FocusStatus>("committed");

  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<ApiFocusSuggestion[]>([]);

  useEffect(() => {
    if (!loaded) fetch();
  }, [loaded, fetch]);

  const visible = useMemo(
    () => focuses.filter((f) => f.status !== "done"),
    [focuses],
  );

  function startAdd(prefillName?: string) {
    setAdding(true);
    setDraftName(prefillName ?? "");
    setDraftEndgoal("");
    setDraftDue("");
    setDraftStatus("committed");
    setConfirmRemoveId(null);
  }

  function cancelAdd() {
    setAdding(false);
    setDraftName("");
    setDraftEndgoal("");
    setDraftDue("");
  }

  async function handleCreate() {
    const name = draftName.trim();
    if (!name) return;
    try {
      await create({
        name,
        endgoal: draftEndgoal.trim() || name,
        status: draftStatus,
        due_date: draftDue ? new Date(draftDue).toISOString() : null,
      });
      cancelAdd();
    } catch (e) {
      console.error(e);
    }
  }

  async function handleSuggest() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const items = await suggestFocuses();
      setSuggestions(items);
    } catch (e) {
      console.error(e);
    } finally {
      setSuggesting(false);
    }
  }

  function dismissSuggestion(name: string) {
    setSuggestions((prev) => prev.filter((s) => s.name !== name));
  }

  async function acceptSuggestion(s: ApiFocusSuggestion) {
    dismissSuggestion(s.name);
    startAdd(s.name);
  }

  return (
    <div
      style={{
        background: "#fff",
        border: "0.5px solid rgba(0,0,0,0.08)",
        borderRadius: 12,
        padding: "16px 20px",
        fontFamily: FONT,
        marginTop: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "#8E8E93",
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          focuses
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={handleSuggest}
            disabled={suggesting}
            style={hdrBtn(suggesting)}
          >
            {suggesting ? "✦ suggesting..." : "✦ suggest"}
          </button>
          <button onClick={() => startAdd()} style={hdrBtn(false)}>
            + add
          </button>
        </div>
      </div>

      {visible.length === 0 && suggestions.length === 0 && !adding ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: "20px 0",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, color: "#3C3C43" }}>No focuses yet.</div>
          <div style={{ fontSize: 12, color: "#8E8E93" }}>
            Gooni can suggest some based on your notes.
          </div>
          <button
            onClick={handleSuggest}
            disabled={suggesting}
            style={{
              fontSize: 12,
              padding: "6px 14px",
              borderRadius: 6,
              background: "#1a1a1a",
              color: "#fff",
              border: "none",
              cursor: suggesting ? "default" : "pointer",
              marginTop: 4,
              fontFamily: FONT,
            }}
          >
            {suggesting ? "✦ suggesting..." : "✦ suggest focuses"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {visible.map((f, i) => {
            const badge = computeBadge(f);
            const faded = badge === "neglected";
            const showNudge = badge === "inconsistent" || badge === "neglected";
            const isLast = i === visible.length - 1;
            return (
              <div
                key={f.id}
                style={{
                  padding: "10px 0",
                  borderBottom: isLast ? "none" : "0.5px solid rgba(0,0,0,0.07)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: faded ? "#8E8E93" : "#1C1C1E",
                      fontWeight: 500,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={f.endgoal}
                  >
                    {f.name}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#8E8E93",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ageLabel(f)}
                  </span>
                  <span style={badgeStyle(badge)}>{BADGE_LABEL[badge]}</span>
                  {confirmRemoveId === f.id ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ fontSize: 12, color: "#8E8E93" }}>
                        remove?
                      </span>
                      <button
                        onClick={async () => {
                          setConfirmRemoveId(null);
                          try { await remove(f.id); } catch (e) { console.error(e); }
                        }}
                        style={removeYesBtn()}
                      >
                        yes
                      </button>
                      <button
                        onClick={() => setConfirmRemoveId(null)}
                        style={removeNoBtn()}
                      >
                        no
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmRemoveId(f.id)}
                      title="Remove"
                      style={{
                        fontSize: 13,
                        color: "#8E8E93",
                        opacity: 0.5,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: "2px 4px",
                        lineHeight: 1,
                      }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "0.5")}
                    >
                      ×
                    </button>
                  )}
                </div>

                {showNudge && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 12, color: "#8E8E93", flex: 1, minWidth: 160 }}>
                      {f.last_activity_at
                        ? `No activity in ${f.days_since_activity ?? 0} days — how's it going?`
                        : "Never logged activity."}
                    </span>
                    <button
                      onClick={async () => {
                        try { await heartbeat(f.id); } catch (e) { console.error(e); }
                      }}
                      style={nudgeBtn(false)}
                    >
                      still on it
                    </button>
                    <button
                      onClick={async () => {
                        try { await update(f.id, { status: "done" }); } catch (e) { console.error(e); }
                      }}
                      style={nudgeBtn(true)}
                    >
                      abandon
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {adding && (
            <div
              style={{
                background: "#F8F8F8",
                border: "0.5px solid rgba(0,0,0,0.08)",
                borderRadius: 8,
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginTop: 8,
              }}
            >
              <div>
                <div style={formLabel()}>focus</div>
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") cancelAdd();
                  }}
                  placeholder="what are you working toward?"
                  style={formInput(true)}
                />
              </div>
              <div>
                <div style={formLabel()}>
                  end goal <span style={{ opacity: 0.5 }}>(optional)</span>
                </div>
                <input
                  value={draftEndgoal}
                  onChange={(e) => setDraftEndgoal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") cancelAdd();
                  }}
                  placeholder="what does done look like?"
                  style={formInput(false)}
                />
              </div>
              <div>
                <div style={formLabel()}>
                  target date <span style={{ opacity: 0.5 }}>(optional)</span>
                </div>
                <input
                  type="date"
                  value={draftDue}
                  onChange={(e) => setDraftDue(e.target.value)}
                  placeholder="leave blank if open-ended"
                  style={formInput(false)}
                />
              </div>
              <div>
                <div style={formLabel()}>status</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["committed", "pending", "someday"] as FocusStatus[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setDraftStatus(s)}
                      style={statusOpt(draftStatus === s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={handleCreate} style={formSave()}>
                  create focus
                </button>
                <button onClick={cancelAdd} style={formCancel()}>
                  cancel
                </button>
              </div>
            </div>
          )}

          {suggestions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
              {suggestions.map((s) => (
                <div
                  key={s.name}
                  style={{
                    background: "#F8F8F8",
                    border: "0.5px solid rgba(0,0,0,0.08)",
                    borderRadius: 8,
                    padding: "12px 14px",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                  }}
                >
                  <div style={{ fontSize: 16, marginTop: 1 }}>
                    {suggestionEmoji(s.name)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: "#1C1C1E", fontWeight: 500, marginBottom: 3 }}>
                      {s.name}
                    </div>
                    <div style={{ fontSize: 12, color: "#8E8E93", lineHeight: 1.5 }}>
                      {s.reason}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      <button onClick={() => acceptSuggestion(s)} style={sugAccept()}>
                        make it a focus
                      </button>
                      <button onClick={() => dismissSuggestion(s.name)} style={sugDismiss()}>
                        dismiss
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function hdrBtn(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    color: active ? "#fff" : "#8E8E93",
    background: active ? "#1a1a1a" : "#F2F2F7",
    border: "0.5px solid",
    borderColor: active ? "#1a1a1a" : "rgba(0,0,0,0.08)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function badgeStyle(b: ActivityBadge): React.CSSProperties {
  const s = BADGE_STYLE[b];
  return {
    fontSize: 11,
    padding: "2px 7px",
    borderRadius: 4,
    fontWeight: 500,
    background: s.bg,
    color: s.fg,
    border: s.border ? `0.5px solid ${s.border}` : "none",
    whiteSpace: "nowrap",
    fontFamily: FONT,
  };
}

function nudgeBtn(danger: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "3px 9px",
    borderRadius: 5,
    border: `0.5px solid ${danger ? "#F7C1C1" : "rgba(0,0,0,0.08)"}`,
    background: "#F2F2F7",
    color: danger ? "#A32D2D" : "#3C3C43",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: FONT,
  };
}

function removeYesBtn(): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 7px",
    borderRadius: 4,
    background: "transparent",
    color: "#A32D2D",
    border: "0.5px solid #F7C1C1",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function removeNoBtn(): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 7px",
    borderRadius: 4,
    background: "transparent",
    color: "#8E8E93",
    border: "0.5px solid rgba(0,0,0,0.08)",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function formLabel(): React.CSSProperties {
  return {
    fontSize: 11,
    color: "#8E8E93",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 3,
    fontFamily: FONT,
  };
}

function formInput(active: boolean): React.CSSProperties {
  return {
    fontSize: 13,
    color: "#1C1C1E",
    background: "#fff",
    border: `0.5px solid ${active ? "#4ADE80" : "rgba(0,0,0,0.08)"}`,
    borderRadius: 6,
    padding: "7px 10px",
    width: "100%",
    boxSizing: "border-box",
    outline: "none",
    fontFamily: FONT,
  };
}

function statusOpt(selected: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 5,
    border: `0.5px solid ${selected ? "#1a1a1a" : "rgba(0,0,0,0.08)"}`,
    background: selected ? "#1a1a1a" : "#fff",
    color: selected ? "#fff" : "#3C3C43",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function formSave(): React.CSSProperties {
  return {
    fontSize: 13,
    padding: "6px 16px",
    borderRadius: 6,
    background: "#1a1a1a",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function formCancel(): React.CSSProperties {
  return {
    fontSize: 13,
    padding: "6px 12px",
    borderRadius: 6,
    background: "transparent",
    color: "#8E8E93",
    border: "0.5px solid rgba(0,0,0,0.08)",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function sugAccept(): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "4px 12px",
    borderRadius: 5,
    background: "#1a1a1a",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    fontFamily: FONT,
  };
}

function sugDismiss(): React.CSSProperties {
  return {
    fontSize: 12,
    padding: "4px 10px",
    borderRadius: 5,
    background: "transparent",
    color: "#8E8E93",
    border: "0.5px solid rgba(0,0,0,0.08)",
    cursor: "pointer",
    fontFamily: FONT,
  };
}
