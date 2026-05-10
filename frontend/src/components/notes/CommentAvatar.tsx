import { Bot } from "lucide-react";
import { GooniLogo } from "../GooniLogo";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Identity = normalized author shape used by both the comment renderer and
// the settings preview. Author free-text from the server gets folded down
// into one of these four kinds.
//   - claude / gooni:  brand visuals (asterisk, logo)
//   - owner:           Daniel — uploaded avatar OR an initial "D" tile
//   - user:            randos (currently future-only — public commenting
//                      isn't wired yet, but the bot avatar is ready when it is)
export type Identity =
  | { kind: "claude"; display: string }
  | { kind: "gooni"; display: string }
  | { kind: "owner"; display: string; initial: string }
  | { kind: "user"; display: string };

export function identityFor(rawAuthor: string): Identity {
  const a = (rawAuthor || "").trim().toLowerCase();
  if (a === "claude" || a === "claude code" || a === "claude-code" || a === "claudecode") {
    return { kind: "claude", display: "Claude Code" };
  }
  if (a === "gooni") {
    return { kind: "gooni", display: "Gooni" };
  }
  // "daniel" is the only authenticated identity so far. Treat as owner.
  if (a === "daniel") {
    return { kind: "owner", display: "Daniel", initial: "D" };
  }
  const display = rawAuthor
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return { kind: "user", display: display || "Anonymous" };
}

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

// Light pastel palette — used for both the owner-initial tile and the
// rando-bot tile. Each entry pairs a soft tinted background with a deeper
// matching foreground so initials / icons stay legible. Indexed by a
// stable hash of the display name so the same author always lands on the
// same colour.
const PASTELS: { bg: string; fg: string }[] = [
  { bg: "#EEEDFE", fg: "#3C3489" }, // violet
  { bg: "#E6F1FB", fg: "#0C447C" }, // blue
  { bg: "#E1F5EE", fg: "#0F6E56" }, // green
  { bg: "#FCEFE3", fg: "#9A4D14" }, // peach
  { bg: "#FDE9F0", fg: "#9C2A5B" }, // rose
  { bg: "#FEF6D6", fg: "#7A5800" }, // amber
  { bg: "#E6F4F1", fg: "#0F5750" }, // teal
  { bg: "#F1ECFB", fg: "#4A2A8A" }, // lavender
];

function pastelFor(name: string): { bg: string; fg: string } {
  const h = hashName(name.toLowerCase());
  return PASTELS[h % PASTELS.length];
}

// Authentic Anthropic Claude burst — orange disc carrying the 4-point
// asterisk mark. Recognizable at comment-avatar size.
function ClaudeMark({ size = 36 }: { size?: number }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: "linear-gradient(135deg, #E8A87C 0%, #D97757 60%, #C7593E 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 1px 3px rgba(199,89,62,0.32), inset 0 0 0 1px rgba(255,255,255,0.16)",
        flex: "none",
      }}
      aria-label="Claude Code"
      title="Claude Code"
    >
      <svg
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M50 4 C52 28, 56 38, 72 42 C88 46, 96 48, 96 50 C96 52, 88 54, 72 58 C56 62, 52 72, 50 96 C48 72, 44 62, 28 58 C12 54, 4 52, 4 50 C4 48, 12 46, 28 42 C44 38, 48 28, 50 4 Z"
          fill="#FFFFFF"
        />
      </svg>
    </div>
  );
}

function GooniAvatar({ size = 36 }: { size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      overflow: "hidden",
      background: "#0F0F0F",
      display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: "0 1px 3px rgba(15,15,15,0.30)",
      flex: "none",
    }}>
      <GooniLogo size={Math.round(size * 0.92)} />
    </div>
  );
}

// Owner tile — Daniel's profile pic when uploaded, otherwise a soft
// pastel disc carrying his initial. Matches the redesign mockup
// (`gooni_comment_avatar_options.html`) bar-for-bar.
function OwnerInitialAvatar({ initial, name, size }: { initial: string; name: string; size: number }) {
  const palette = pastelFor(name);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: palette.bg,
        color: palette.fg,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: Math.round(size * 0.42),
        flex: "none",
        userSelect: "none",
      }}
      aria-label={name}
      title={name}
    >
      {initial}
    </div>
  );
}

// Rando avatar — soft pastel disc with a bot glyph in the matching deeper
// tone. Public-comment surface (when it lands) hands every anonymous
// commenter one of these, indexed by display name so they stay consistent
// per author across reloads.
function BotAvatar({ name, size }: { name: string; size: number }) {
  const palette = pastelFor(name);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: palette.bg,
        display: "flex", alignItems: "center", justifyContent: "center",
        flex: "none",
      }}
      aria-label={name}
      title={name}
    >
      <Bot size={Math.round(size * 0.55)} color={palette.fg} strokeWidth={1.8} />
    </div>
  );
}

interface CommentAvatarProps {
  identity: Identity;
  // Owner-kind only: uploaded avatar URL takes priority over the initial
  // tile. Ignored for claude / gooni / user.
  avatarUrl?: string | null;
  size?: number;
}

export function CommentAvatar({ identity, avatarUrl, size = 36 }: CommentAvatarProps) {
  if (identity.kind === "claude") return <ClaudeMark size={size} />;
  if (identity.kind === "gooni") return <GooniAvatar size={size} />;
  if (identity.kind === "owner") {
    if (avatarUrl) {
      return (
        <img
          src={avatarUrl}
          alt={identity.display}
          title={identity.display}
          style={{
            width: size, height: size, borderRadius: "50%",
            objectFit: "cover", flex: "none",
            boxShadow: "0 1px 3px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(0,0,0,0.06)",
          }}
        />
      );
    }
    return <OwnerInitialAvatar initial={identity.initial} name={identity.display} size={size} />;
  }
  return <BotAvatar name={identity.display} size={size} />;
}
