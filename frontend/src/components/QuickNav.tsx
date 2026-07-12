import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, Radio, FileText, FileSearch, Brain, Globe, Plug } from "lucide-react";
import { FONT } from "../ui";


interface NavTarget {
  key: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

// Cmd+K palette mounted in __root so every page (including /public/*) has a
// way to jump anywhere. Specifically scratches Daniel's #134 itch — getting
// from /memories, /chat-audit, /public back home used to mean clicking
// the logo, then back into the sidebar. Now Cmd+K → type → Enter, anywhere.
export function QuickNav() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd+K (or Ctrl+K) toggles. Ignored when typing in an input/textarea so
  // we don't hijack note editor / chat input shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const targets: NavTarget[] = useMemo(() => [
    {
      key: "log",
      label: "Log",
      hint: "the ambient feed",
      icon: <Radio size={14} strokeWidth={1.7} />,
      onSelect: () => navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: "log" } }),
    },
    {
      key: "notes",
      label: "All Notes",
      hint: "?view=notes",
      icon: <FileText size={14} strokeWidth={1.7} />,
      onSelect: () => navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: "notes" } }),
    },
    {
      key: "memories",
      label: "Memories",
      hint: "/memories",
      icon: <Brain size={14} strokeWidth={1.7} />,
      onSelect: () => navigate({ to: "/memories", search: { focus: undefined } }),
    },
    {
      key: "audit",
      label: "Eval / Audit",
      hint: "review chat segments",
      icon: <FileSearch size={14} strokeWidth={1.7} />,
      onSelect: () => navigate({ to: "/", search: { audit: true, note: undefined, conv: undefined, segment: undefined, view: undefined } }),
    },
    {
      key: "public",
      label: "Public profile",
      hint: "/public",
      icon: <Globe size={14} strokeWidth={1.7} />,
      onSelect: () => navigate({ to: "/public" }),
    },
    {
      key: "mcp",
      label: "MCP",
      hint: "/public/mcp",
      icon: <Plug size={14} strokeWidth={1.7} />,
      onSelect: () => navigate({ to: "/public/mcp" }),
    },
  ], [navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) =>
      t.label.toLowerCase().includes(q) || t.hint?.toLowerCase().includes(q)
    );
  }, [query, targets]);

  // Clamp active index when filter shrinks the set.
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (target) {
        target.onSelect();
        setOpen(false);
      }
    }
  }

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(15,15,18,0.42)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: "92vw",
          background: "var(--gooni-card, #FFFFFF)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.32), 0 4px 12px rgba(0,0,0,0.12)",
          overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <Search size={15} color="var(--gooni-muted, #8E8E93)" strokeWidth={1.7} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: 14,
              fontFamily: FONT,
              color: "var(--gooni-text, #1C1C1E)",
              background: "transparent",
            }}
          />
          <kbd
            style={{
              fontSize: 10.5,
              color: "var(--gooni-muted, #8E8E93)",
              padding: "2px 6px",
              borderRadius: 4,
              background: "rgba(0,0,0,0.05)",
              fontFamily: FONT,
            }}
          >
            esc
          </kbd>
        </div>

        <div style={{ maxHeight: "50vh", overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "16px 12px", color: "var(--gooni-muted, #8E8E93)", fontSize: 13 }}>
              No matches.
            </div>
          ) : (
            filtered.map((t, i) => (
              <button
                key={t.key}
                onClick={() => { t.onSelect(); setOpen(false); }}
                onMouseEnter={() => setActiveIndex(i)}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "none",
                  background: i === activeIndex ? "rgba(0,0,0,0.06)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: FONT,
                }}
              >
                <span style={{ width: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--gooni-muted, #8E8E93)" }}>
                  {t.icon}
                </span>
                <span style={{ fontSize: 13, color: "var(--gooni-text, #1C1C1E)" }}>{t.label}</span>
                {t.hint && (
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
                    {t.hint}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div style={{ display: "flex", gap: 14, padding: "8px 14px", borderTop: "1px solid rgba(0,0,0,0.06)", fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span style={{ marginLeft: "auto" }}>⌘K toggle</span>
        </div>
      </div>
    </div>
  );
}
