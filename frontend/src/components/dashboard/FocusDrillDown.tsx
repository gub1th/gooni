import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Edit2, GitBranch, Moon, Trash2 } from "lucide-react";
import {
  fetchFocusDetail,
  fetchTodosByFocus,
  renameFocus,
  forkFocus,
  reactivateFocus,
  deleteFocus,
  type ApiFocusDetail,
  type ApiTodo,
} from "../../services/api";

// FocusDrillDown — modal opened by clicking a focus card. Header: name
// + endgoal + state badge (drift/dormant). Two columns of content:
// linked todos (filtered by focus_id) + bound state evidence list.
// Lineage breadcrumb at top when set. Action bar at bottom: Rename,
// Fork, Mark dormant (= delete the focus row — keeps todos via
// focus_service.delete which clears focus_id), or Archive (done=true).

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  focusId: number | null;
  onClose: () => void;
}

export function FocusDrillDown({ focusId, onClose }: Props) {
  const qc = useQueryClient();

  const { data: focus } = useQuery<ApiFocusDetail>({
    queryKey: ["focus-detail", focusId],
    queryFn: () => fetchFocusDetail(focusId!),
    enabled: focusId != null,
  });
  const { data: linkedTodos = [] } = useQuery<ApiTodo[]>({
    queryKey: ["focus-todos", focusId],
    queryFn: () => fetchTodosByFocus(focusId!),
    enabled: focusId != null,
  });

  // Close on Esc.
  useEffect(() => {
    if (focusId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusId, onClose]);

  if (focusId == null) return null;

  const isDrifting = focus?.drift_flagged_at != null && focus?.status !== "dormant";
  const isDormant = focus?.status === "dormant";

  const handleRename = async () => {
    if (!focus) return;
    const text = window.prompt("Rename to:", focus.text);
    if (!text || !text.trim() || text.trim() === focus.text) return;
    await renameFocus(focus.id, { text: text.trim() });
    qc.invalidateQueries({ queryKey: ["focuses"] });
    qc.invalidateQueries({ queryKey: ["focus-detail", focus.id] });
  };

  const handleFork = async () => {
    if (!focus) return;
    const text = window.prompt(
      `Fork "${focus.text}" — new name?\n(Original kept as 'evolved')`,
    );
    if (!text || !text.trim()) return;
    await forkFocus(focus.id, { new_text: text.trim() });
    qc.invalidateQueries({ queryKey: ["focuses"] });
    onClose();
  };

  const handleReactivate = async () => {
    if (!focus) return;
    await reactivateFocus(focus.id);
    qc.invalidateQueries({ queryKey: ["focuses"] });
    qc.invalidateQueries({ queryKey: ["focus-detail", focus.id] });
  };

  const handleDelete = async () => {
    if (!focus) return;
    if (!window.confirm(
      `Delete "${focus.text}"? Linked todos lose their color dot but stay around.`,
    )) return;
    await deleteFocus(focus.id);
    qc.invalidateQueries({ queryKey: ["focuses"] });
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--gooni-card, #fff)",
          borderRadius: 16,
          width: "min(640px, 90vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          padding: 0,
          color: "var(--gooni-text, #1C1C1E)",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "20px 24px 12px",
          borderBottom: "0.5px solid rgba(0,0,0,0.08)",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            {focus?.color && (
              <div style={{
                width: 12, height: 12, borderRadius: "50%",
                background: focus.color, marginTop: 6, flexShrink: 0,
              }} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}>
                {focus?.text ?? "…"}
              </div>
              {focus?.endgoal && (
                <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", marginTop: 4 }}>
                  → {focus.endgoal}
                </div>
              )}
              {focus?.evolved_from_name && (
                <div style={{
                  fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
                  marginTop: 4, fontStyle: "italic",
                }}>
                  ↑ evolved from '{focus.evolved_from_name}'
                </div>
              )}
              {(isDrifting || isDormant) && (
                <div style={{
                  display: "inline-block", marginTop: 6,
                  fontSize: 10, fontWeight: 500,
                  padding: "2px 8px", borderRadius: 999,
                  background: isDormant ? "rgba(0,0,0,0.06)" : "rgba(239,159,39,0.15)",
                  color: isDormant ? "var(--gooni-muted, #8E8E93)" : "#854F0B",
                  textTransform: "uppercase", letterSpacing: 0.4,
                }}>
                  {isDormant ? "dormant" : "drifting"}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: 4, color: "var(--gooni-muted, #8E8E93)",
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body: two columns */}
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr",
          gap: 0, minHeight: 200,
        }}>
          {/* Linked todos */}
          <div style={{
            padding: "14px 20px",
            borderRight: "0.5px solid rgba(0,0,0,0.06)",
          }}>
            <SectionTitle>Linked todos · {linkedTodos.length}</SectionTitle>
            {linkedTodos.length === 0 ? (
              <EmptyHint>No todos linked to this focus.</EmptyHint>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {linkedTodos.map((t) => (
                  <div key={t.id} style={{
                    fontSize: 12,
                    color: t.done ? "var(--gooni-muted, #8E8E93)" : "var(--gooni-text, #1C1C1E)",
                    textDecoration: t.done ? "line-through" : "none",
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: t.done ? "transparent" :
                                  t.state === "doing" ? "#3B82F6" :
                                  "rgba(0,0,0,0.2)",
                      border: t.done ? "0.5px solid rgba(0,0,0,0.3)" : "none",
                    }} />
                    {t.text}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Bound state evidence */}
          <div style={{ padding: "14px 20px" }}>
            <SectionTitle>
              Recent signals · {focus?.evidence?.length ?? 0}
            </SectionTitle>
            {!focus?.evidence?.length ? (
              <EmptyHint>No bound state. Run synth to populate.</EmptyHint>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {focus.evidence.slice(0, 12).map((ev, i) => (
                  <div key={i} style={{
                    fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
                    lineHeight: 1.4,
                  }}>
                    <span style={{
                      fontSize: 9, color: "var(--gooni-muted, #8E8E93)",
                      letterSpacing: 0.4, textTransform: "uppercase",
                      marginRight: 6,
                    }}>
                      {ev.kind}#{ev.id}
                    </span>
                    {ev.snippet?.slice(0, 120)}
                  </div>
                ))}
                {focus.evidence.length > 12 && (
                  <div style={{ fontSize: 10, color: "var(--gooni-muted, #8E8E93)" }}>
                    + {focus.evidence.length - 12} more
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action bar */}
        <div style={{
          padding: "10px 20px",
          borderTop: "0.5px solid rgba(0,0,0,0.08)",
          display: "flex", gap: 6, justifyContent: "flex-end",
        }}>
          <ActionButton icon={<Edit2 size={12} />} label="Rename" onClick={handleRename} />
          <ActionButton icon={<GitBranch size={12} />} label="Fork" onClick={handleFork} />
          {isDormant && (
            <ActionButton icon={<Moon size={12} />} label="Reactivate" onClick={handleReactivate} />
          )}
          <ActionButton icon={<Trash2 size={12} />} label="Delete" onClick={handleDelete} tone="danger" />
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 500, color: "var(--gooni-muted, #8E8E93)",
      letterSpacing: 0.4, textTransform: "uppercase",
      marginBottom: 8,
    }}>{children}</div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
      fontStyle: "italic",
    }}>{children}</div>
  );
}

function ActionButton({ icon, label, onClick, tone = "default" }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "5px 10px", border: "0.5px solid rgba(0,0,0,0.10)",
        background: "var(--gooni-card, #fff)",
        color: tone === "danger" ? "#791F1F" : "var(--gooni-text, #1C1C1E)",
        borderRadius: 6, cursor: "pointer", fontSize: 11,
        fontFamily: FONT,
      }}
    >
      {icon} {label}
    </button>
  );
}
