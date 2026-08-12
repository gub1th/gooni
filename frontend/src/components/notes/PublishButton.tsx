import { useEffect, useRef, useState } from "react";
import { Globe, Lock, ChevronDown, Check } from "lucide-react";
import { frostInk as ctok, FONT } from "../../ui";

/**
 * Confluence-style publish CTA. Sits top-right of the editor as the
 * primary visual focal point — replaces the small globe/pencil icons
 * that were buried inside the floating pill.
 *
 * Three states:
 *   - draft           (is_draft=true)                 → blue "Publish" button
 *   - private (final) (is_draft=false, is_public=false) → muted "Published privately"
 *   - public          (is_public=true)                → green "Published"
 *
 * Click → small dropdown with explicit Publish public / Publish private
 * / Unpublish actions. Matches Gooni's existing soft-elevation pill
 * aesthetic — hairline border, subtle shadow, backdrop blur.
 */

export type PublishVisibility = "draft" | "private" | "public";

interface PublishButtonProps {
  visibility: PublishVisibility;
  onPublishPublic: () => void;
  onPublishPrivate: () => void;
  onUnpublish: () => void;
}


export function PublishButton({
  visibility,
  onPublishPublic,
  onPublishPrivate,
  onUnpublish,
}: PublishButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const isDraft = visibility === "draft";
  const isPublic = visibility === "public";
  const isPrivate = visibility === "private";

  // Button-shape varies with state. Draft = primary tinted CTA, the
  // visual focal point. Published states = subtle pill with status dot.
  const baseStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6,
    height: 26, padding: "0 10px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontFamily: FONT,
    fontSize: 12.5, fontWeight: 500,
    transition: "background 0.12s, color 0.12s",
  };

  // Was built for a white page: an iOS-blue fill with a blue bloom under it for
  // draft, and near-opaque WHITE pills for the two published states — which on
  // the void is the single brightest thing on the surface, glowing in a colour
  // nothing else out here uses. Draft is the one action, so it takes the accent
  // fill; the published states are settled facts and read as quiet text behind a
  // hairline. No shadow on either: depth here is surface, not bloom.
  const variantStyle: React.CSSProperties = isDraft
    ? { background: ctok.accentDim, color: ctok.accent }
    : isPublic
      ? { background: "transparent", color: ctok.accent, boxShadow: `inset 0 0 0 1px ${ctok.hairline}` }
      : { background: "transparent", color: ctok.muted, boxShadow: `inset 0 0 0 1px ${ctok.hairline}` };

  const label = isDraft ? "Publish" : isPublic ? "Published" : "Published privately";
  const icon = isDraft
    ? null
    : isPublic
      ? <Globe size={13} strokeWidth={2.1} />
      : <Lock size={13} strokeWidth={2.1} />;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ ...baseStyle, ...variantStyle }}
        title={
          isDraft
            ? "Publish this note"
            : isPublic
              ? "Note is published publicly — click to manage"
              : "Note is finalized (private) — click to manage"
        }
      >
        {/* Status dot for published states — green when public, slate for private. */}
        {!isDraft && (
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: isPublic ? "#16A34A" : "#94A3B8",
            flexShrink: 0,
          }} />
        )}
        {icon}
        <span>{label}</span>
        <ChevronDown size={13} strokeWidth={2} style={{ opacity: 0.75 }} />
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            minWidth: 220,
            background: ctok.card, borderRadius: 10,
            padding: 5,
            boxShadow: `inset 0 0 0 1px ${ctok.hairline}`,
            display: "flex", flexDirection: "column", gap: 2,
            fontFamily: FONT, fontSize: 13.5,
          }}
        >
          <MenuItem
            icon={<Globe size={14} strokeWidth={1.9} color={ctok.accent} />}
            label="Publish public"
            description="Anyone with the link can read"
            active={isPublic}
            onClick={() => { onPublishPublic(); setOpen(false); }}
          />
          <MenuItem
            icon={<Lock size={14} strokeWidth={1.9} color={ctok.muted} />}
            label="Publish privately"
            description="Marks as finalized, keeps it private"
            active={isPrivate}
            onClick={() => { onPublishPrivate(); setOpen(false); }}
          />
          {!isDraft && (
            <>
              <div style={{ height: 1, background: ctok.hairline, margin: "4px 4px" }} />
              <MenuItem
                icon={<span style={{ width: 14, height: 14, display: "inline-block" }} />}
                label="Move back to draft"
                description=""
                danger
                onClick={() => { onUnpublish(); setOpen(false); }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon, label, description, onClick, active, danger,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "8px 10px", borderRadius: 7,
        border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left",
        color: danger ? ctok.bad : ctok.text,
        fontFamily: FONT, fontSize: 13.5, fontWeight: 500,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = ctok.hover)}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
    >
      <span style={{ display: "inline-flex", alignItems: "center", marginTop: 1, flexShrink: 0 }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {label}
          {active && <Check size={12} strokeWidth={2.2} color={ctok.accent} />}
        </span>
        {description && (
          <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--gooni-faint, #94A3B8)" }}>{description}</span>
        )}
      </span>
    </button>
  );
}
