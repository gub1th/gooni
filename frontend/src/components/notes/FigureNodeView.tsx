import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import type { FigureAlign } from "./FigureExtension";
import { color as ctok } from "../../ui";

// One image-with-caption block. Renders a <figure> wrapper for both
// alignment + width, plus selection chrome (resize handle, alignment
// popover, caption editor) that disappears once the node loses focus.
//
// All persisted state lives on node.attrs — nothing here is component-local
// except transient drag state. That means caption + width + alignment
// roundtrip cleanly through `editor.getHTML()` -> server -> next mount.
export function FigureNodeView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const align: FigureAlign = node.attrs.align ?? "center";
  const width: number = node.attrs.width ?? 100;
  const caption: string = node.attrs.caption ?? "";

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [editingCaption, setEditingCaption] = useState(false);
  const [draftCaption, setDraftCaption] = useState(caption);
  const captionInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the local draft in sync if the attr changes from elsewhere
  // (undo/redo, collaborative edit).
  useEffect(() => {
    setDraftCaption(caption);
  }, [caption]);

  const isEditable = editor.isEditable;

  // Drag-to-resize: anchor on the wrapper's container width so the % stays
  // meaningful regardless of viewport. Captures pointer so the drag
  // continues even if the mouse leaves the handle.
  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isEditable) return;
      e.preventDefault();
      e.stopPropagation();
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const parent = wrapper.parentElement;
      if (!parent) return;
      const parentWidth = parent.getBoundingClientRect().width;
      const startX = e.clientX;
      const startWidth = width;

      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        // Right-side handle: drag right grows. For left-aligned figure
        // this is intuitive. Center / right alignment also map this way
        // (drag right = bigger), which is consistent with Google Docs.
        const deltaPct = (dx / parentWidth) * 100;
        const next = Math.max(15, Math.min(100, Math.round(startWidth + deltaPct)));
        updateAttributes({ width: next });
      };
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [isEditable, updateAttributes, width]
  );

  const setAlign = (next: FigureAlign) => {
    updateAttributes({ align: next });
  };

  const startCaptionEdit = () => {
    if (!isEditable) return;
    setEditingCaption(true);
    // Focus on next tick so the input is mounted.
    requestAnimationFrame(() => captionInputRef.current?.focus());
  };

  const commitCaption = () => {
    setEditingCaption(false);
    if (draftCaption !== caption) {
      updateAttributes({ caption: draftCaption });
    }
  };

  // Float-based side-by-side layout. Left/right floats so two adjacent
  // figures both with align=left|right wrap together; center clears so
  // it always sits on its own line. The wrapper width scales the inner
  // image down via max-width:100%.
  const figureStyle: React.CSSProperties = {
    width: `${width}%`,
    margin:
      align === "center" ? "12px auto"
      : align === "left"  ? "12px 14px 12px 0"
      :                     "12px 0 12px 14px",
    float:
      align === "center" ? "none"
      : align === "left"  ? "left"
      :                     "right",
    clear: align === "center" ? "both" : "none",
    position: "relative",
    boxSizing: "border-box",
    padding: 0,
  };

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      as="figure"
      data-figure=""
      data-align={align}
      data-width={width}
      className={`gooni-figure gooni-figure-${align}${selected ? " gooni-figure-selected" : ""}`}
      style={figureStyle}
    >
      <div style={{ position: "relative", lineHeight: 0 }}>
        <img
          src={node.attrs.src}
          alt={node.attrs.alt ?? ""}
          style={{
            display: "block",
            width: "100%",
            height: "auto",
            borderRadius: 8,
            outline: selected ? "2px solid #007AFF" : "none",
            outlineOffset: 1,
          }}
          draggable={false}
        />

        {/* Resize handle — bottom-right. Only shown when selected so
            non-selected images stay clean. */}
        {selected && isEditable && (
          <div
            role="slider"
            aria-label="Resize image"
            aria-valuenow={width}
            aria-valuemin={15}
            aria-valuemax={100}
            onPointerDown={handleResizeStart}
            style={{
              position: "absolute",
              right: -6, bottom: -6,
              width: 14, height: 14,
              borderRadius: 3,
              background: "#007AFF",
              border: "2px solid #fff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
              cursor: "nwse-resize",
              touchAction: "none",
            }}
          />
        )}

        {/* Alignment popover — appears above the image when selected. */}
        {selected && isEditable && (
          <div
            contentEditable={false}
            style={{
              position: "absolute",
              top: -38, left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              gap: 1,
              background: ctok.text,
              borderRadius: 8,
              padding: "3px 4px",
              boxShadow: "0 6px 22px rgba(0,0,0,0.22)",
              zIndex: 5,
            }}
            // Stop the editor from losing the selection when these are clicked.
            onMouseDown={(e) => e.preventDefault()}
          >
            {([
              { v: "left",   Icon: AlignLeft,   title: "Align left" },
              { v: "center", Icon: AlignCenter, title: "Align center" },
              { v: "right",  Icon: AlignRight,  title: "Align right" },
            ] as const).map(({ v, Icon, title }) => (
              <button
                key={v}
                title={title}
                onClick={() => setAlign(v)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26,
                  padding: 0,
                  borderRadius: 5,
                  border: "none",
                  background: align === v ? "rgba(255,255,255,0.18)" : "transparent",
                  color: align === v ? "#fff" : "rgba(255,255,255,0.78)",
                  cursor: "pointer",
                  transition: "background 0.1s, color 0.1s",
                }}
              >
                <Icon size={14} strokeWidth={1.9} />
              </button>
            ))}
            {/* width readout — handy reference while dragging */}
            <span style={{
              alignSelf: "center",
              padding: "0 6px",
              fontSize: 10,
              color: "rgba(255,255,255,0.55)",
              fontVariantNumeric: "tabular-nums",
              minWidth: 30,
              textAlign: "right",
            }}>{width}%</span>
          </div>
        )}
      </div>

      {/* Caption — empty placeholder shown when editable and image selected. */}
      {(caption || editingCaption || (selected && isEditable)) && (
        <figcaption
          contentEditable={false}
          onClick={startCaptionEdit}
          style={{
            marginTop: 6,
            fontSize: 13,
            lineHeight: 1.4,
            color: caption ? "var(--gooni-muted, #6E6E73)" : "rgba(0,0,0,0.35)",
            textAlign: "center",
            cursor: isEditable ? "text" : "default",
            userSelect: "text",
            minHeight: 18,
          }}
        >
          {editingCaption ? (
            <input
              ref={captionInputRef}
              value={draftCaption}
              onChange={(e) => setDraftCaption(e.target.value)}
              onBlur={commitCaption}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCaption();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraftCaption(caption);
                  setEditingCaption(false);
                }
              }}
              placeholder="Add a caption"
              style={{
                width: "80%",
                background: "transparent",
                border: "none",
                outline: "none",
                textAlign: "center",
                fontSize: 13,
                color: "var(--gooni-text, #1C1C1E)",
                fontFamily: "inherit",
              }}
            />
          ) : caption ? (
            caption
          ) : (
            <span style={{ fontStyle: "italic" }}>add a caption</span>
          )}
        </figcaption>
      )}
    </NodeViewWrapper>
  );
}
