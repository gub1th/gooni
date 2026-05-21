import { useNavigate } from "@tanstack/react-router";
import {
  Plus,
  Search,
  FileText,
  Brain,
  ClipboardList,
  Settings as SettingsIcon,
  PanelLeftOpen,
} from "lucide-react";
import { useState } from "react";
import { useGooniThemeStore, THEME_PALETTES } from "../../stores/useGooniThemeStore";
import { GooniLogo } from "../GooniLogo";
import { SettingsModal } from "../SettingsModal";

/**
 * Claude-style icon rail. Renders when sidebarOpen=false in AppShell.
 * 56px wide column with icon-only shortcuts to every top-level
 * destination. Tooltips on hover (native `title` for now).
 *
 * Compose / search / All Notes / Memories / Audit / Settings — same
 * set the full sidebar surfaces, just collapsed to icons.
 */

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface CollapsedSidebarProps {
  isDashboard: boolean;
  isNotes: boolean;
  isChat: boolean;
  isEval: boolean;
  onOpen: () => void;
  onLogoClick: () => void;
  onAllNotes: () => void;
  onNewChat: () => void;
  onOpenEval?: () => void;
}

const ICON_TINT = {
  allNotes: "#6366F1",
  newChat: "#10B981",
  memories: "#0EA5E9",
  audit: "#0891B2",
  settings: "#64748B",
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
        background: active ? "rgba(0,0,0,0.09)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: color ?? "#475569",
        transition: "background 0.12s",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)";
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
  isDashboard,
  isNotes,
  isChat,
  isEval,
  onOpen,
  onLogoClick,
  onAllNotes,
  onNewChat,
  onOpenEval,
}: CollapsedSidebarProps) {
  const navigate = useNavigate();
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        height: "100vh",
        background: palette.sidebar,
        borderRight: "1px solid rgba(0,0,0,0.08)",
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
        title={isDashboard ? "Back to notes" : "Dashboard"}
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
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
      >
        <GooniLogo size={22} />
      </button>

      <RailButton
        Icon={Plus}
        title="New chat"
        active={isChat}
        onClick={onNewChat}
        color={ICON_TINT.newChat}
      />
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
        onClick={() => navigate({ to: "/memories", search: { focus: undefined } })}
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
                list: undefined,
                audit: true,
                segment: undefined,
                view: undefined,
              },
            });
        }}
        color={ICON_TINT.audit}
      />

      {/* Spacer — push Settings to the bottom */}
      <div style={{ flex: 1 }} />

      <RailButton
        Icon={SettingsIcon}
        title="Settings"
        onClick={() => setSettingsOpen(true)}
        color={ICON_TINT.settings}
      />

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
