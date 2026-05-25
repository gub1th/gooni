import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { FONT, color as ctok } from "../../ui";

// Shared chrome for the dashboard "daily tracker" blocks (todos, habits,
// promises) so they read as one family instead of three bespoke widgets.
// The todos block is the reference look; these primitives reproduce its
// card, section header, add-row, and left status dot so habits + promises
// can drop onto the same pattern.
//
// Section chrome (header label + "+" button) is terracotta everywhere —
// it's the dashboard's "today" accent and ties the three blocks together.
// Per-item color stays bespoke (habit identity color, promise state color)
// via StatusDot.

const TERRACOTTA = "#C9772E";

// ── StatusDot ─────────────────────────────────────────────────────────────
// The unified left glyph for non-actionable rows (habits, promises). Todos
// keep their cycle-checkbox since the glyph there is a control, not a label.
export function StatusDot({
  color,
  size = 8,
  title,
}: {
  color: string;
  size?: number;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

// ── ItemCard ────────────────────────────────────────────────────────────
// One row in a tracker list. Matches the todo row card exactly: white
// surface, hairline warm border, radius 8, hover darken. `children` may be
// a render-prop so a consumer can reveal hover-only affordances (delete,
// crown) without wiring its own hover state.
export function ItemCard({
  onClick,
  dim = false,
  children,
  style,
}: {
  onClick?: () => void;
  dim?: boolean;
  children: React.ReactNode | ((hover: boolean) => React.ReactNode);
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        background: hover ? "rgba(0,0,0,0.025)" : "var(--gooni-card, #FFFFFF)",
        border: "0.5px solid var(--gooni-border, rgba(155,130,70,0.15))",
        borderRadius: 8,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        cursor: clickable ? "pointer" : "default",
        opacity: dim ? 0.5 : 1,
        transition: "background 0.12s, opacity 0.12s",
        ...style,
      }}
    >
      {typeof children === "function" ? children(hover) : children}
    </div>
  );
}

// ── SectionHeader ─────────────────────────────────────────────────────────
// Lowercase label on the left, optional progress counter + a terracotta
// "+" button on the right. Mirrors the todos section header.
export function SectionHeader({
  label,
  count,
  total,
  onAdd,
  addTitle = "Add",
  marginTop = 0,
  rightExtra,
}: {
  label: string;
  count?: number;
  total?: number;
  onAdd: () => void;
  addTitle?: string;
  marginTop?: number;
  // Optional controls rendered left of the "+" (e.g. promise tabs).
  rightExtra?: React.ReactNode;
}) {
  const showCounter = count != null && total != null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: `${marginTop}px 2px 8px`,
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: "var(--gooni-muted, #6B6557)",
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {showCounter && (
          <span
            style={{
              fontSize: 12,
              color: "var(--gooni-muted, #9CA3AF)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {count} / {total}
          </span>
        )}
        {rightExtra}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          title={addTitle}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: "rgba(201,119,46,0.10)",
            color: TERRACOTTA,
            border: "0.5px solid rgba(201,119,46,0.25)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

// ── AddItemRow ──────────────────────────────────────────────────────────
// The "Add a …" placeholder that expands into an inline input. Owns its own
// open/draft state; `onSubmit` fires on Enter (and is also called on blur if
// non-empty via the parent's choice — here Enter only, Esc cancels). The
// `trailing` slot (rendered between input and pill, only while open) hosts
// extras like the habit build/break toggle.
export function AddItemRow({
  pill,
  placeholder,
  onSubmit,
  onOpenChange,
  trailing,
  open: controlledOpen,
}: {
  pill: string;
  placeholder: string;
  onSubmit: (text: string) => void;
  onOpenChange?: (open: boolean) => void;
  trailing?: React.ReactNode;
  open?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const open = controlledOpen ?? openState;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function setOpen(v: boolean) {
    setOpenState(v);
    onOpenChange?.(v);
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function submit() {
    const text = draft.trim();
    if (!text) {
      setOpen(false);
      setDraft("");
      return;
    }
    onSubmit(text);
    setDraft("");
  }

  return (
    <div
      onClick={() => !open && setOpen(true)}
      style={{
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        opacity: open ? 1 : 0.55,
        borderBottom: "0.5px solid rgba(0,0,0,0.06)",
        cursor: "text",
        marginTop: 2,
      }}
    >
      <Plus size={14} color="#8E8E93" />
      {open ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setDraft("");
            }
          }}
          onBlur={() => {
            if (!draft.trim()) setOpen(false);
          }}
          placeholder={placeholder}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            fontFamily: FONT,
            fontSize: 13,
            background: "transparent",
            color: "var(--gooni-text, #1C1C1E)",
          }}
        />
      ) : (
        <span style={{ flex: 1, fontSize: 13, color: ctok.muted }}>
          {placeholder}
        </span>
      )}
      {open && trailing}
      <span
        style={{
          fontSize: 11,
          color: ctok.muted,
          background: "rgba(0,0,0,0.05)",
          padding: "2px 8px",
          borderRadius: 99,
        }}
      >
        {pill}
      </span>
    </div>
  );
}
