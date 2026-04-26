import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  fetchSuggestionsToday,
  dismissSuggestion,
  refreshSuggestions,
  fetchSuggestionPrompts,
  patchSuggestionPrompt,
  type ApiSuggestion,
  type SuggestionCategory,
} from "../services/api";
import { useFocusesStore } from "../stores/useFocusesStore";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

// Mixed feed: 1 read + 1 do + 1 revisit. Each item has a settings gear that
// edits a per-category user prompt — the LLM treats those as PRIORITY when
// generating the next batch ("I want random AI startups", "more outdoor
// activities", etc).

const CATEGORY_META: Record<SuggestionCategory, { icon: string; label: string; subtitle: string }> = {
  read:    { icon: "📖", label: "Read",    subtitle: "ideas to chew on" },
  do:      { icon: "🎯", label: "Do",      subtitle: "go break a habit" },
  revisit: { icon: "💭", label: "Revisit", subtitle: "your past self has a take" },
};

const CATEGORY_ORDER: SuggestionCategory[] = ["read", "do", "revisit"];

export function SuggestionsCard() {
  const navigate = useNavigate();
  const { focuses, loaded, fetch: fetchFocuses } = useFocusesStore();
  const [items, setItems] = useState<Record<SuggestionCategory, ApiSuggestion[]>>({ read: [], do: [], revisit: [] });
  const [prompts, setPrompts] = useState<Record<SuggestionCategory, string>>({ read: "", do: "", revisit: "" });
  const [refreshing, setRefreshing] = useState(false);
  const [loaded2, setLoaded2] = useState(false);
  // Which category's gear popover is currently open (null = none).
  const [editing, setEditing] = useState<SuggestionCategory | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!loaded) fetchFocuses();
  }, [loaded, fetchFocuses]);

  // Don't even fetch suggestions until Daniel has at least one focus —
  // the LLM output goes generic without that signal.
  const hasFocus = focuses.some((f) => f.status !== "done");

  useEffect(() => {
    if (!hasFocus) return;
    if (loaded2) return;
    Promise.all([fetchSuggestionsToday(), fetchSuggestionPrompts()])
      .then(([feed, p]) => {
        setItems(feed);
        setPrompts(p);
        setLoaded2(true);
      })
      .catch(console.error);
  }, [hasFocus, loaded2]);

  if (!hasFocus) return null;
  if (!loaded2 && CATEGORY_ORDER.every((c) => items[c].length === 0)) return null;

  async function handleDismiss(id: number) {
    setItems((prev) => {
      const next = { ...prev };
      for (const c of CATEGORY_ORDER) next[c] = next[c].filter((s) => s.id !== id);
      return next;
    });
    try { await dismissSuggestion(id); } catch (e) { console.error(e); }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshSuggestions();
      const feed = await fetchSuggestionsToday();
      setItems(feed);
    } catch (e) {
      console.error(e);
    } finally {
      setRefreshing(false);
    }
  }

  function openGear(cat: SuggestionCategory) {
    setDraft(prompts[cat] ?? "");
    setEditing(cat);
  }
  async function saveGear() {
    if (!editing) return;
    const cat = editing;
    const next = draft.trim();
    setEditing(null);
    setPrompts((p) => ({ ...p, [cat]: next }));
    try {
      await patchSuggestionPrompt(cat, next);
    } catch (e) {
      console.error(e);
    }
  }

  function handleClickItem(s: ApiSuggestion) {
    if (s.category === "revisit" && s.note_id) {
      navigate({ to: "/", search: { note: s.note_id, conv: undefined } });
      return;
    }
    if (s.source_url) {
      window.open(s.source_url, "_blank", "noreferrer");
    }
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 10,
      }}>
        <span style={{
          fontSize: 12, color: "#8E8E93", letterSpacing: 0.6,
          textTransform: "uppercase", fontFamily: FONT,
        }}>
          for you today
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Regenerate"
          style={{
            border: "none", background: "transparent",
            color: "#8E8E93", fontSize: 11, cursor: refreshing ? "default" : "pointer",
            fontFamily: FONT,
          }}
        >
          {refreshing ? "regenerating…" : "↻ refresh"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {CATEGORY_ORDER.map((cat) => {
          const list = items[cat];
          const meta = CATEGORY_META[cat];
          if (list.length === 0) return null;
          const item = list[0];
          const userPromptSet = (prompts[cat] ?? "").trim().length > 0;
          return (
            <div
              key={cat}
              onClick={() => handleClickItem(item)}
              style={{
                background: "#fff",
                border: "1px solid rgba(0,0,0,0.07)",
                borderRadius: 12,
                padding: "12px 14px",
                fontFamily: FONT,
                position: "relative",
                cursor: (item.note_id || item.source_url) ? "pointer" : "default",
                transition: "border-color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => {
                if (item.note_id || item.source_url) {
                  (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.15)";
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.07)";
              }}
            >
              {/* Type chip + gear + dismiss */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 11, fontWeight: 600, color: "#3C3C43",
                  background: "rgba(0,0,0,0.05)", borderRadius: 999,
                  padding: "2px 9px", letterSpacing: 0.3,
                  textTransform: "uppercase",
                }}>
                  <span aria-hidden style={{ fontSize: 12 }}>{meta.icon}</span>
                  {meta.label}
                </span>
                <span style={{ fontSize: 11, color: "#AEAEB2" }}>{meta.subtitle}</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={(e) => { e.stopPropagation(); openGear(cat); }}
                  title={userPromptSet ? "Custom prompt set — edit" : "Set a custom prompt"}
                  style={{
                    width: 22, height: 22, borderRadius: 6, border: "none",
                    background: userPromptSet ? "rgba(74,222,128,0.18)" : "transparent",
                    color: userPromptSet ? "#16A34A" : "#8E8E93",
                    cursor: "pointer", fontSize: 12, lineHeight: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >⚙</button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDismiss(item.id); }}
                  title="Dismiss"
                  style={{
                    width: 22, height: 22, borderRadius: 6, border: "none",
                    background: "transparent", color: "#C7C7CC", cursor: "pointer",
                    fontSize: 13, lineHeight: 1,
                  }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#3C3C43")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#C7C7CC")}
                >×</button>
              </div>

              <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1C1C1E", lineHeight: 1.35 }}>
                {item.source_url && cat !== "revisit" ? (
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{ color: "inherit", textDecoration: "none" }}
                  >
                    {item.title}
                  </a>
                ) : item.title}
              </div>
              <div style={{ fontSize: 12.5, color: "#6E6E73", marginTop: 4, lineHeight: 1.5 }}>
                {item.body}
              </div>

              {/* Inline gear popover */}
              {editing === cat && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: 10,
                    padding: 10,
                    borderRadius: 8,
                    background: "rgba(74,222,128,0.06)",
                    border: "1px dashed rgba(74,222,128,0.4)",
                    display: "flex", flexDirection: "column", gap: 8,
                  }}
                >
                  <div style={{ fontSize: 11, color: "#6E6E73", fontFamily: FONT }}>
                    custom prompt for <strong>{meta.label.toLowerCase()}</strong> — Gooni treats this as priority
                  </div>
                  <textarea
                    autoFocus
                    rows={2}
                    placeholder={
                      cat === "read" ? "e.g. random AI startups that sound interesting" :
                      cat === "do" ? "e.g. more outdoor activities, NYC-specific" :
                      "e.g. surface notes related to my Tolaria focus"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveGear();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    style={{
                      width: "100%", boxSizing: "border-box",
                      fontFamily: FONT, fontSize: 12.5,
                      border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
                      padding: "6px 8px", outline: "none", resize: "vertical",
                    }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={saveGear}
                      style={{
                        background: "#1C1C1E", color: "#fff",
                        border: "none", borderRadius: 6, padding: "5px 12px",
                        fontFamily: FONT, fontSize: 12, fontWeight: 500, cursor: "pointer",
                      }}
                    >Save</button>
                    <button
                      onClick={() => setEditing(null)}
                      style={{
                        background: "transparent", color: "#6E6E73",
                        border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
                        padding: "5px 12px",
                        fontFamily: FONT, fontSize: 12, cursor: "pointer",
                      }}
                    >Cancel</button>
                    {(prompts[cat] ?? "").trim() && (
                      <>
                        <div style={{ flex: 1 }} />
                        <button
                          onClick={() => { setDraft(""); }}
                          title="Clear custom prompt"
                          style={{
                            background: "transparent", color: "#C76B6B",
                            border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
                            padding: "5px 10px",
                            fontFamily: FONT, fontSize: 12, cursor: "pointer",
                          }}
                        >Clear</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
