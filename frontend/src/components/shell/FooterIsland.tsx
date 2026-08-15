import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Globe, Plug } from "lucide-react";
import { frost, z } from "../../ui";

/**
 * Bottom-left island — Public profile + MCP connector, reachable from every
 * surface (not just notes, where they used to live pinned to the sidebar
 * footer). Small, frosted, subtle: two icon buttons in one pill under the
 * IconRail, following the same treatment (frost + hairline, no shadow).
 */
export function FooterIsland() {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<"public" | "mcp" | null>(null);

  const items: { key: "public" | "mcp"; label: string; Icon: typeof Globe; to: string }[] = [
    { key: "public", label: "Public", Icon: Globe, to: "/public/notes" },
    { key: "mcp", label: "MCP", Icon: Plug, to: "/public/mcp" },
  ];

  return (
    <div
      style={{
        position: "fixed", left: 12, bottom: 12,
        zIndex: z.overlay + 2,
        display: "flex", alignItems: "center", gap: 2,
        padding: "5px 6px", borderRadius: 999,
        ...frost.chrome,
      }}
    >
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => navigate({ to: it.to })}
          onMouseEnter={() => setHovered(it.key)}
          onMouseLeave={() => setHovered((h) => (h === it.key ? null : h))}
          title={it.label}
          aria-label={it.label}
          style={{
            display: "flex", alignItems: "center", gap: 5,
            height: 26, padding: hovered === it.key ? "0 9px" : "0 6px",
            borderRadius: 999, border: "none", cursor: "pointer",
            background: hovered === it.key ? "rgb(var(--gooni-ink, 244 245 244) / 0.09)" : "transparent",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.65)",
            fontSize: 11, fontWeight: 500,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            transition: "background 140ms ease, padding 140ms ease",
            overflow: "hidden", whiteSpace: "nowrap",
          }}
        >
          <it.Icon size={13} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          {hovered === it.key && <span>{it.label}</span>}
        </button>
      ))}
    </div>
  );
}
