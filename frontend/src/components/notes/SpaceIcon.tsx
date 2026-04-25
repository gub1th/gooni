import {
  Folder, FileText, Notebook, BookOpen,
  Code2, Terminal, Cpu, Database,
  Briefcase, Target, Lightbulb, Sparkles,
  Rocket, Compass, Heart, Star,
  Flame, Coffee, Music, Camera,
  Pen, Calendar, Map, Globe,
  Inbox,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// "lucide:<IconName>" is the persisted form for icon-based spaces. Anything
// else stored on `space.emoji` is treated as a legacy emoji string and rendered
// as text. New picks always save in the lucide form.
const LUCIDE_PREFIX = "lucide:";

// Curated identity icons for spaces. The picker shows these in a 4×6 grid.
// Order matters — top row first, then by mental category (work / making /
// life / objects). Keep this list short on purpose; a hundred choices is the
// opposite of "minimalistic and clean."
export const SPACE_ICON_OPTIONS: { name: string; Icon: LucideIcon }[] = [
  { name: "Folder",    Icon: Folder },
  { name: "FileText",  Icon: FileText },
  { name: "Notebook",  Icon: Notebook },
  { name: "BookOpen",  Icon: BookOpen },

  { name: "Code2",     Icon: Code2 },
  { name: "Terminal",  Icon: Terminal },
  { name: "Cpu",       Icon: Cpu },
  { name: "Database",  Icon: Database },

  { name: "Briefcase", Icon: Briefcase },
  { name: "Target",    Icon: Target },
  { name: "Lightbulb", Icon: Lightbulb },
  { name: "Sparkles",  Icon: Sparkles },

  { name: "Rocket",    Icon: Rocket },
  { name: "Compass",   Icon: Compass },
  { name: "Heart",     Icon: Heart },
  { name: "Star",      Icon: Star },

  { name: "Flame",     Icon: Flame },
  { name: "Coffee",    Icon: Coffee },
  { name: "Music",     Icon: Music },
  { name: "Camera",    Icon: Camera },

  { name: "Pen",       Icon: Pen },
  { name: "Calendar",  Icon: Calendar },
  { name: "Map",       Icon: Map },
  { name: "Globe",     Icon: Globe },
];

// Lookup map keyed on the persisted name. Explicit map (rather than dynamic
// import * as Icons[name]) keeps lucide-react tree-shaking working — only the
// icons referenced here ship in the bundle.
const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  SPACE_ICON_OPTIONS.map((o) => [o.name, o.Icon] as const),
);
ICON_MAP.Inbox = Inbox; // not in the picker grid but used as the General-space default

export function isLucideIconValue(emoji: string | null | undefined): boolean {
  return !!emoji && emoji.startsWith(LUCIDE_PREFIX);
}

export function lucideIconValue(name: string): string {
  return `${LUCIDE_PREFIX}${name}`;
}

interface SpaceIconProps {
  emoji: string | null | undefined;
  size?: number;
  color?: string;
  fallbackName?: keyof typeof ICON_MAP | string;
}

// Renders whatever a space stores: a `lucide:<Name>` string → the matching
// lucide component, a legacy emoji string → that emoji, or nothing → fallback
// icon (Folder by default). One render path keeps the sidebar/notes-list/move
// menus visually consistent without each call site needing to know about the
// "lucide:" sentinel.
export function SpaceIcon({ emoji, size = 14, color, fallbackName = "Folder" }: SpaceIconProps) {
  if (isLucideIconValue(emoji)) {
    const name = (emoji as string).slice(LUCIDE_PREFIX.length);
    const Icon = ICON_MAP[name];
    if (Icon) {
      return <Icon size={size} strokeWidth={1.7} color={color ?? "#475569"} />;
    }
    // Unknown icon name on disk — fall through to default rather than crash.
  }
  if (emoji && emoji.trim()) {
    // Legacy emoji fallback. Slightly bigger optical size since emojis read smaller.
    return <span style={{ fontSize: size + 1, lineHeight: 1, display: "inline-flex" }}>{emoji}</span>;
  }
  const F = ICON_MAP[fallbackName] ?? Folder;
  return <F size={size} strokeWidth={1.7} color={color ?? "#94A3B8"} />;
}
