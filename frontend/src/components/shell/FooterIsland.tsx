import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Globe, Plug } from "lucide-react";
import { frost, z } from "../../ui";

/**
 * Bottom-left island — Public profile + MCP connector, reachable from every
 * surface (not just notes, where they used to live pinned to the sidebar
 * footer). Small, frosted, subtle: two icon buttons in one pill under the
 * IconRail, following the same treatment (frost + hairline, no shadow).
 *
 * Stacked VERTICALLY (2026-08-15) to match the IconRail pill directly above
 * it — a horizontal pill under a vertical one read as two different nav
 * idioms sharing the same corner. The label flies out to the right on hover,
 * same vocabulary as IconRail's own label flyout, rather than growing the
 * pill's width in place (which would widen a column-stacked pill sideways).
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
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        padding: "6px 6px", borderRadius: 999,
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
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 28, height: 28,
            borderRadius: 999, border: "none", cursor: "pointer", padding: 0,
            background: hovered === it.key ? "rgb(var(--gooni-ink, 244 245 244) / 0.09)" : "transparent",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.65)",
            transition: "background 140ms ease",
          }}
        >
          <it.Icon size={13} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          <span
            style={{
              position: "absolute", left: "calc(100% + 10px)", top: "50%",
              transform: `translateY(-50%) translateX(${hovered === it.key ? 0 : -4}px)`,
              whiteSpace: "nowrap", pointerEvents: "none",
              padding: "5px 10px", borderRadius: 8,
              fontSize: 11.5, fontWeight: 500,
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.9)",
              ...frost.chrome,
              opacity: hovered === it.key ? 1 : 0,
              transition: "opacity 140ms ease, transform 140ms ease",
            }}
          >
            {it.label}
          </span>
        </button>
      ))}
    </div>
  );
}
