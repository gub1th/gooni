import { useEffect, useState } from "react";
import {
  fetchSuggestionsToday,
  dismissSuggestion,
  refreshSuggestions,
  type ApiSuggestion,
} from "../services/api";
import { useFocusesStore } from "../stores/useFocusesStore";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

export function SuggestionsCard() {
  const { focuses, loaded, fetch: fetchFocuses } = useFocusesStore();
  const [discovery, setDiscovery] = useState<ApiSuggestion[]>([]);
  const [whimsy, setWhimsy] = useState<ApiSuggestion[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded2, setLoaded2] = useState(false);

  useEffect(() => {
    if (!loaded) fetchFocuses();
  }, [loaded, fetchFocuses]);

  // Don't even fetch suggestions until Daniel has at least one focus —
  // the LLM output goes generic without that signal.
  const hasFocus = focuses.some((f) => f.status !== "done");

  useEffect(() => {
    if (!hasFocus) return;
    if (loaded2) return;
    fetchSuggestionsToday()
      .then(({ discovery, whimsy }) => {
        setDiscovery(discovery);
        setWhimsy(whimsy);
        setLoaded2(true);
      })
      .catch(console.error);
  }, [hasFocus, loaded2]);

  if (!hasFocus) return null;
  if (!loaded2 && discovery.length === 0 && whimsy.length === 0) return null;

  async function handleDismiss(id: number) {
    setDiscovery((d) => d.filter((s) => s.id !== id));
    setWhimsy((w) => w.filter((s) => s.id !== id));
    try {
      await dismissSuggestion(id);
    } catch (e) {
      console.error(e);
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshSuggestions();
      const { discovery, whimsy } = await fetchSuggestionsToday();
      setDiscovery(discovery);
      setWhimsy(whimsy);
    } catch (e) {
      console.error(e);
    } finally {
      setRefreshing(false);
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

      <Section title="Discovery" subtitle="ideas to chew on" items={discovery} onDismiss={handleDismiss} />
      <Section title="Whimsy" subtitle="comfort-zone breakers" items={whimsy} onDismiss={handleDismiss} />
    </div>
  );
}

interface SectionProps {
  title: string;
  subtitle: string;
  items: ApiSuggestion[];
  onDismiss: (id: number) => void;
}

function Section({ title, subtitle, items, onDismiss }: SectionProps) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", fontFamily: FONT }}>
          {title}
        </span>
        <span style={{ fontSize: 11, color: "#AEAEB2", fontFamily: FONT }}>{subtitle}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {items.map((s) => (
          <div
            key={s.id}
            style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.07)",
              borderRadius: 10,
              padding: "10px 12px",
              fontFamily: FONT,
              position: "relative",
            }}
          >
            <button
              onClick={() => onDismiss(s.id)}
              title="Dismiss"
              style={{
                position: "absolute", top: 6, right: 6,
                width: 18, height: 18, borderRadius: 6, border: "none",
                background: "transparent", color: "#C7C7CC", cursor: "pointer",
                fontSize: 11, lineHeight: 1,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#3C3C43")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#C7C7CC")}
            >×</button>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1C1C1E", lineHeight: 1.35, paddingRight: 14 }}>
              {s.source_url ? (
                <a href={s.source_url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                  {s.title}
                </a>
              ) : s.title}
            </div>
            <div style={{ fontSize: 11.5, color: "#6E6E73", marginTop: 4, lineHeight: 1.4 }}>
              {s.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
