import { useNavigate } from "@tanstack/react-router";
import {
  Search,
  FileText,
  Brain,
  ClipboardList,
  PanelLeftOpen,
} from "lucide-react";
import { GooniLogo } from "../GooniLogo";
import { FONT } from "../../ui";
import { ink } from "../ambient/ambientInk";

/**
 * Claude-style icon rail. Renders when sidebarOpen=false in AppShell.
 * 56px wide column with icon-only shortcuts to every top-level
 * destination. Tooltips on hover (native `title` for now).
 *
 * Compose / search / All Notes / Memories / Audit — same
 * set the full sidebar surfaces, just collapsed to icons.
 */


interface CollapsedSidebarProps {
  isNotes: boolean;
  isEval: boolean;
  onOpen: () => void;
  onLogoClick: () => void;
  onAllNotes: () => void;
  onOpenEval?: () => void;
}

const ICON_TINT = {
  allNotes: "#6366F1",
  memories: "#0EA5E9",
  audit: "#0891B2",
  search: "#475569",
} as const;

function RailButton({
  Icon,
  title,
  active,
  onClick,
  color,
}: {
  Icon: typeof FileText;
  title: string;
  active?: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        border: "none",
        background: active ? "rgb(var(--gooni-tint, 0 0 0) / 0.09)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: color ?? "var(--gooni-muted, #475569)",
        transition: "background 0.12s",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.05)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <Icon size={17} strokeWidth={1.8} />
    </button>
  );
}

export function CollapsedSidebar({
  isNotes,
  isEval,
  onOpen,
  onLogoClick,
  onAllNotes,
  onOpenEval,
}: CollapsedSidebarProps) {
  const navigate = useNavigate();

  function fireQuickNav() {
    // QuickNav listens for Cmd+K / Ctrl+K globally. Synthesize one so the
    // icon-rail Search button opens it without prop drilling a callback.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true }),
    );
  }

  return (
    <div
      style={{
        width: 56,
        minWidth: 56,
        // Same two fixes as the expanded Sidebar: transparent rather than the
        // app-card `sidebar` palette, which read as a lit slab against the
        // void; and `100%` rather than `100vh`, which overflowed the panel by
        // the height of the session band.
        height: "100%",
        background: "transparent",
        borderRight: `1px solid ${ink(0.08)}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "10px 0 12px",
        boxSizing: "border-box",
        fontFamily: FONT,
      }}
    >
      {/* Open-sidebar — top, mirrors close button position in expanded view */}
      <RailButton
        Icon={PanelLeftOpen}
        title="Open sidebar"
        onClick={onOpen}
      />

      {/* Gooni logo button — small affordance for branding + Dashboard nav */}
      <button
        onClick={onLogoClick}
        title="Home"
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: 6,
          marginBottom: 10,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.05)")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
      >
        <GooniLogo size={22} />
      </button>

      <RailButton
        Icon={Search}
        title="Quick nav (⌘K)"
        onClick={fireQuickNav}
        color={ICON_TINT.search}
      />
      <RailButton
        Icon={FileText}
        title="All Notes"
        active={isNotes}
        onClick={onAllNotes}
        color={ICON_TINT.allNotes}
      />
      <RailButton
        Icon={Brain}
        title="Memories"
        onClick={() => navigate({ to: "/", search: { view: "memories" } })}
        color={ICON_TINT.memories}
      />
      <RailButton
        Icon={ClipboardList}
        title="Audit"
        active={isEval}
        onClick={() => {
          if (onOpenEval) onOpenEval();
          else
            navigate({
              to: "/",
              search: {
                note: undefined,
                conv: undefined,
                audit: true,
                segment: undefined,
                view: undefined,
              },
            });
        }}
        color={ICON_TINT.audit}
      />

      <div style={{ flex: 1 }} />
    </div>
  );
}
