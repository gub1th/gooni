import { Globe, Lock } from "lucide-react";
import { frostInk as ctok, FONT } from "../../ui";

/**
 * Public/private toggle. Sits top-right of the editor.
 *
 * TWO states, because there were only ever two. It shipped as a three-state
 * ceremony — draft → private (final) → public — but `/public` filters on
 * `is_public` ALONE, so `draft` and `private (final)` were byte-identical to
 * every consumer: same visibility, same search, same feeds. The only thing
 * that differed was the label this component rendered. A note is private
 * (the default) or public; nothing in between.
 *
 * No dropdown either. One toggle needs one click, and the menu existed to
 * disambiguate a middle state that is gone.
 */

interface PublishButtonProps {
  isPublic: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
}

export function PublishButton({ isPublic, onPublish, onUnpublish }: PublishButtonProps) {
  return (
    <button
      onClick={isPublic ? onUnpublish : onPublish}
      title={isPublic ? "Public — click to make private" : "Private — click to publish"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        height: 26, padding: "0 10px",
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        fontFamily: FONT,
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: "-0.01em",
        background: isPublic ? "rgba(22,163,74,0.14)" : "transparent",
        color: isPublic ? "#16A34A" : ctok.muted,
        transition: "background 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!isPublic) (e.currentTarget as HTMLButtonElement).style.background = ctok.hover;
      }}
      onMouseLeave={(e) => {
        if (!isPublic) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {isPublic ? <Globe size={13} /> : <Lock size={13} />}
      <span>{isPublic ? "Public" : "Private"}</span>
    </button>
  );
}
