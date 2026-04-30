import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchItemTree, updateItem, createItem, type ApiItemTree } from "../services/api";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

type DragSrc = { id: number };

// Module-level drag carrier — HTML5 dataTransfer drops focus across components,
// so we keep a tiny in-memory bus to coordinate ListView → here.
// (Only one drag in flight, so a single ref is fine.)
const dragBus: { current: DragSrc | null } = { current: null };

export function getPrimaryDragBus() { return dragBus; }

interface Props {
  // Bumped by callers (Dashboard) when the primary might have changed elsewhere.
  refreshKey?: number;
}

export function PrimaryFocusCard({ refreshKey }: Props) {
  const queryClient = useQueryClient();
  // Shares the cache key with ActivityCard — one fetch feeds both cards.
  const { data: tree } = useQuery<ApiItemTree>({
    queryKey: ["item-tree"],
    queryFn: fetchItemTree,
  });
  const focuses = tree?.focuses ?? [];
  const primary = useMemo(() => focuses.find((f) => f.is_primary) ?? null, [focuses]);

  const [dragHover, setDragHover] = useState(false);
  const [newText, setNewText] = useState("");
  const lastPrimaryId = useRef<number | null>(null);
  useEffect(() => {
    lastPrimaryId.current = primary?.id ?? null;
  }, [primary]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["item-tree"] });

  // External promotions (ListView "make primary", FocusModal toggle) fire this
  // event so the card refetches without prop drilling.
  useEffect(() => {
    const handler = () => { refresh(); };
    window.addEventListener("gooni-primary-changed", handler);
    return () => window.removeEventListener("gooni-primary-changed", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch when parent bumps refreshKey.
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshKey]);

  async function promote(id: number) {
    try {
      await updateItem(id, { is_primary: true });
      refresh();
    } catch (e) {
      console.error("promote failed", e);
    }
  }

  async function createAndPromote() {
    const t = newText.trim();
    if (!t) return;
    try {
      const created = await createItem({ text: t, committed: true });
      await updateItem(created.id, { is_primary: true });
      setNewText("");
      refresh();
    } catch (e) {
      console.error("createAndPromote failed", e);
    }
  }

  async function unsetPrimary() {
    if (!primary) return;
    try {
      await updateItem(primary.id, { is_primary: false });
      lastPrimaryId.current = null;
      refresh();
    } catch (e) {
      console.error("unsetPrimary failed", e);
    }
  }

  // Visible state shapes:
  //   1. primary set → big card, vine animation, shows endgoal + progress
  //   2. primary unset → inline input "+ new primary focus" + scrollable list
  //      of existing focuses (done filtered out) to promote.

  return (
    <div
      onDragOver={(e) => {
        if (dragBus.current) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragHover(true);
        }
      }}
      onDragLeave={() => setDragHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragHover(false);
        const src = dragBus.current;
        dragBus.current = null;
        if (src) promote(src.id);
      }}
      style={{
        position: "relative",
        // No box. Daniel pushed back on the equal-weight border treatment —
        // primary should read like a heading, not a boxed widget. The drag-
        // hover and primary-set states get subtle background tints only.
        background: dragHover
          ? "rgba(245,158,11,0.06)"
          : "transparent",
        borderRadius: 10,
        padding: primary ? "4px 0 10px" : "8px 0 6px",
        marginBottom: 14,
        transition: "background 160ms",
      }}
    >
      {primary ? (
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 14, color: "#F59E0B", flexShrink: 0 }}>★</span>
            <span style={{
              fontSize: 24, fontWeight: 700, color: "#1C1C1E",
              lineHeight: 1.25, letterSpacing: "-0.3px",
              flex: 1, minWidth: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {primary.text}
            </span>
            <button
              onClick={unsetPrimary}
              title="Unset primary"
              style={{
                border: "none", background: "transparent",
                color: "#AEAEB2", fontSize: 11, fontFamily: FONT, cursor: "pointer",
                padding: "2px 4px", borderRadius: 6, flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#6B6B70"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#AEAEB2"; }}
            >unset</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingLeft: 24 }}>
            {primary.endgoal && (
              <span style={{ fontSize: 13, color: "#6B6B70", lineHeight: 1.5,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {primary.endgoal}
              </span>
            )}
            {primary.progress.total > 0 && (
              <span style={{
                fontSize: 11, color: "#92400E", flexShrink: 0,
                fontVariantNumeric: "tabular-nums",
              }}>
                {primary.progress.done} / {primary.progress.total}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, color: "#F59E0B", flexShrink: 0 }}>★</span>
            <input
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createAndPromote();
                if (e.key === "Escape") setNewText("");
              }}
              placeholder="What's the most important thing right now?"
              style={{
                fontSize: 17, padding: "4px 0",
                border: "none", borderBottom: "1px solid transparent",
                background: "transparent",
                fontFamily: FONT, color: "#1C1C1E",
                outline: "none", flex: 1, minWidth: 0,
                transition: "border-color 120ms",
              }}
              onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderBottomColor = "#F59E0B"; }}
              onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderBottomColor = "transparent"; }}
            />
          </div>
          {focuses.length > 0 && (
            <p style={{
              margin: "6px 0 0 24px", fontSize: 11, color: "#C7C7CC", lineHeight: 1.4,
            }}>
              Or open one below and toggle "Set as primary."
            </p>
          )}
        </div>
      )}
    </div>
  );
}

