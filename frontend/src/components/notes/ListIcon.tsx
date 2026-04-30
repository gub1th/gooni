import {
  Folder, ListChecks, Archive, Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Mirror of SpaceIcon's contract for lists. New lists default to a lucide
// icon based on `type`; user-set custom emojis still render as text so the
// option remains for those who want it.
const TYPE_ICONS: Record<string, LucideIcon> = {
  focus: Target,
  todo: ListChecks,
  backlog: Archive,
  generic: Folder,
};

const TYPE_TINT: Record<string, string> = {
  focus: "#EAB308",
  todo: "#10B981",
  backlog: "#94A3B8",
  generic: "#64748B",
};

interface Props {
  emoji: string | null | undefined;
  type: string;
  size?: number;
}

export function ListIcon({ emoji, type, size = 14 }: Props) {
  if (emoji && emoji.trim()) {
    return <span style={{ fontSize: size + 1, lineHeight: 1, display: "inline-flex" }}>{emoji}</span>;
  }
  const Icon = TYPE_ICONS[type] ?? Folder;
  const color = TYPE_TINT[type] ?? "#64748B";
  return <Icon size={size} strokeWidth={1.7} color={color} />;
}
