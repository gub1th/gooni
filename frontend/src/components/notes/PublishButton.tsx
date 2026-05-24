import { useEffect, useRef, useState } from "react";
import { Globe, Lock, ChevronDown, Check } from "lucide-react";
import { color as ctok, FONT } from "../../ui";

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
    transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
    boxShadow: "0 1px 2px rgba(15,23,42,0.05), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
  };

  const variantStyle: React.CSSProperties = isDraft
    ? {
        background: "rgba(10,132,255,0.95)",
        color: "#fff",
        boxShadow: "0 2px 8px rgba(10,132,255,0.22), 0 1px 2px rgba(10,132,255,0.18)",
      }
    : isPublic
      ? {
          background: "rgba(255,255,255,0.92)",
          color: "#0F6E56",
          backdropFilter: "blur(10px) saturate(1.6)",
          WebkitBackdropFilter: "blur(10px) saturate(1.6)",
        }
      : {
          background: "rgba(255,255,255,0.92)",
          color: "#475569",
          backdropFilter: "blur(10px) saturate(1.6)",
          WebkitBackdropFilter: "blur(10px) saturate(1.6)",
        };

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
            background: "#fff", borderRadius: 10,
            padding: 5,
            boxShadow:
              "0 12px 28px rgba(15,23,42,0.16), 0 2px 6px rgba(15,23,42,0.10), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
            display: "flex", flexDirection: "column", gap: 2,
            fontFamily: FONT, fontSize: 13.5,
          }}
        >
          <MenuItem
            icon={<Globe size={14} strokeWidth={1.9} color="#0F6E56" />}
            label="Publish public"
            description="Anyone with the link can read"
            active={isPublic}
            onClick={() => { onPublishPublic(); setOpen(false); }}
          />
          <MenuItem
            icon={<Lock size={14} strokeWidth={1.9} color="#475569" />}
            label="Publish privately"
            description="Marks as finalized, keeps it private"
            active={isPrivate}
            onClick={() => { onPublishPrivate(); setOpen(false); }}
          />
          {!isDraft && (
            <>
              <div style={{ height: 1, background: "rgba(15,23,42,0.08)", margin: "4px 4px" }} />
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
        color: danger ? "#EF4444" : ctok.text,
        fontFamily: FONT, fontSize: 13.5, fontWeight: 500,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.05)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
    >
      <span style={{ display: "inline-flex", alignItems: "center", marginTop: 1, flexShrink: 0 }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {label}
          {active && <Check size={12} strokeWidth={2.2} color="#0F6E56" />}
        </span>
        {description && (
          <span style={{ fontSize: 11.5, fontWeight: 400, color: "#94A3B8" }}>{description}</span>
        )}
      </span>
    </button>
  );
}
