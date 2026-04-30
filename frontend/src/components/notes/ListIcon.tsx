import {
  ListChecks, Inbox, Target, ListTodo,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Lists are visually distinct from Spaces: spaces render plain lucide marks
// (BookOpen, Folder, etc.), lists wear a tinted squircle so the eye reads
// "list view" at a glance even before the label registers.
const TYPE_ICONS: Record<string, LucideIcon> = {
  focus: Target,
  todo: ListChecks,
  backlog: Inbox,
  generic: ListTodo,
};

const TYPE_TINT: Record<string, { bg: string; fg: string }> = {
  focus:   { bg: "#FEF3C7", fg: "#A16207" },
  todo:    { bg: "#DCFCE7", fg: "#15803D" },
  backlog: { bg: "#E0E7FF", fg: "#4338CA" },
  generic: { bg: "#F1F5F9", fg: "#475569" },
};

interface Props {
  emoji: string | null | undefined;
  type: string;
  size?: number;
}

export function ListIcon({ emoji, type, size = 14 }: Props) {
  // Custom user-set emoji overrides the lucide default. Render bare so the
  // emoji owns the look — no squircle so it reads like a personal mark.
  if (emoji && emoji.trim()) {
    return <span style={{ fontSize: size + 1, lineHeight: 1, display: "inline-flex" }}>{emoji}</span>;
  }
  const Icon = TYPE_ICONS[type] ?? ListTodo;
  const tint = TYPE_TINT[type] ?? TYPE_TINT.generic;
  const box = size + 8;
  return (
    <span style={{
      width: box, height: box, borderRadius: 6,
      background: tint.bg,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      <Icon size={size - 2} strokeWidth={2} color={tint.fg} />
    </span>
  );
}
