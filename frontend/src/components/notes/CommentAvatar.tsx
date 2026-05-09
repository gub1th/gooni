import { GooniLogo } from "../GooniLogo";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Identity = normalized author shape used by both the comment renderer and
// the settings preview. Author free-text from the server gets folded down
// into one of these three kinds.
export type Identity =
  | { kind: "claude"; display: string }
  | { kind: "gooni"; display: string }
  | { kind: "user"; display: string };

export function identityFor(rawAuthor: string): Identity {
  const a = (rawAuthor || "").trim().toLowerCase();
  if (a === "claude" || a === "claude code" || a === "claude-code" || a === "claudecode") {
    return { kind: "claude", display: "Claude Code" };
  }
  if (a === "gooni") {
    return { kind: "gooni", display: "Gooni" };
  }
  const display = rawAuthor
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return { kind: "user", display: display || "Anonymous" };
}

// "Goofy" default avatars — chosen for whimsy, not realism. Picked
// deterministically by name hash so the same author always lands on the
// same animal on every reload / surface. Fallback for "user"-kind
// identities without an uploaded avatar.
const GOOFY_EMOJI = [
  "🦄", "🐸", "🦊", "🐢", "🦔", "🐧", "🦦", "🦝",
  "🦡", "🦒", "🐙", "🦋", "🐼", "🦥", "🦃", "🦩",
  "🐲", "🦕", "🦖", "🐳", "🦭", "🦨",
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

export function goofyEmojiFor(name: string): string {
  const h = hashName(name.toLowerCase());
  return GOOFY_EMOJI[h % GOOFY_EMOJI.length];
}

function gradientFor(name: string): { from: string; to: string; ring: string } {
  const h = hashName(name.toLowerCase());
  const hue = h % 360;
  const altHue = (hue + 38) % 360;
  return {
    from: `hsl(${hue} 70% 56%)`,
    to: `hsl(${altHue} 72% 44%)`,
    ring: `hsl(${hue} 70% 56% / 0.18)`,
  };
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
        {/* Anthropic asterisk: 4 tear-drop petals at 0°/90°/180°/270° with
            a pinched waist, in white. */}
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

function GoofyAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const grad = gradientFor(name);
  const emoji = goofyEmojiFor(name);
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: `linear-gradient(135deg, ${grad.from} 0%, ${grad.to} 100%)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: Math.round(size * 0.55),
        fontFamily: FONT,
        boxShadow: `0 1px 3px ${grad.ring}, inset 0 0 0 1px rgba(255,255,255,0.18)`,
        flex: "none",
        userSelect: "none",
      }}
      aria-label={name}
      title={name}
    >
      {emoji}
    </div>
  );
}

interface CommentAvatarProps {
  identity: Identity;
  // For "user"-kind identities, an uploaded avatar URL takes priority over
  // the goofy default. Ignored for claude/gooni — those use brand visuals.
  avatarUrl?: string | null;
  size?: number;
}

export function CommentAvatar({ identity, avatarUrl, size = 36 }: CommentAvatarProps) {
  if (identity.kind === "claude") return <ClaudeMark size={size} />;
  if (identity.kind === "gooni") return <GooniAvatar size={size} />;
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
  return <GoofyAvatar name={identity.display} size={size} />;
}
