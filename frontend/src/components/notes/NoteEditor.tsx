import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { updateNote as apiUpdateNote, memorizeNote as apiMemorizeNote, touchNote as apiTouchNote, embedNote as apiEmbedNote, fetchRelatedNotes, type ApiNote, type SpaceSuggestion } from "../../services/api";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useJarvisStore } from "../../stores/useJarvisStore";
import { useSpacesStore } from "../../stores/useSpacesStore";

function useEditorStyles() {
  useEffect(() => {
    if (document.querySelector("style[data-gooni-note-editor]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-gooni-note-editor", "true");
    style.textContent = `
      .gooni-note-editor .ProseMirror { outline: none; }
      .gooni-note-editor .ProseMirror p { margin: 0 0 6px; }
      .gooni-note-editor .ProseMirror ul,
      .gooni-note-editor .ProseMirror ol { padding-left: 20px; margin: 0 0 6px; }
      .gooni-note-editor .ProseMirror > p:first-child:empty::before {
        content: "Start writing...";
        color: #AEAEB2;
        pointer-events: none;
        float: left;
        height: 0;
      }
    `;
    document.head.appendChild(style);
  }, []);
}

function formatNoteDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return "Today at " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) +
    " at " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

type SaveStatus = "idle" | "saving" | "saved";

export function NoteEditor() {
  useEditorStyles();

  const { selectedSpaceId, notes, activeNoteId, updateNote, moveNote, selectNote, loadNotes, selectSpace } = useNotesContentStore();
  const { isOpen: jarvisOpen, toggle: toggleJarvis } = useJarvisStore();
  const { spaces } = useSpacesStore();

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  const [localTitle, setLocalTitle] = useState(activeNote?.title ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [movePicker, setMovePicker] = useState(false);
  const [relatedNotes, setRelatedNotes] = useState<ApiNote[]>([]);
  const [spaceSuggestion, setSpaceSuggestion] = useState<SpaceSuggestion | null>(null);
  const movePickerRef = useRef<HTMLDivElement>(null);
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const bodyRef = useRef<string>(activeNote?.content ?? "");
  const titleRef = useRef<string>(activeNote?.title ?? "");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveNoteId = useRef<number | null>(activeNoteId);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalTitle(activeNote?.title ?? "");
    bodyRef.current = activeNote?.content ?? "";
    titleRef.current = activeNote?.title ?? "";
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaveStatus("idle");
    setLastSavedTime(null);
    setSpaceSuggestion(null);
    setRelatedNotes([]);
  }, [activeNoteId]);

  // Load related notes after note settles (quiet, non-blocking)
  useEffect(() => {
    if (!activeNoteId || activeNoteId < 0) return;
    const t = setTimeout(async () => {
      const notes = await fetchRelatedNotes(activeNoteId);
      setRelatedNotes(notes.filter((n) => n.id !== activeNoteId));
    }, 1000);
    return () => clearTimeout(t);
  }, [activeNoteId]);

  // Memorize previous note on leave; touch new note on enter — catches ALL navigation paths
  useEffect(() => {
    const prev = prevActiveNoteId.current;
    prevActiveNoteId.current = activeNoteId;
    if (prev === activeNoteId) return; // initial mount, no change

    if (prev && prev > 0) {
      embedAndCheck(prev);
      if (useNotesContentStore.getState().isDirty) {
        apiMemorizeNote(prev).catch(() => {});
      }
      useNotesContentStore.setState({ isDirty: false });
    }
    if (activeNoteId && activeNoteId > 0) {
      apiTouchNote(activeNoteId).catch(() => {});
    }
  }, [activeNoteId]);

  // Auto-focus title when a new empty note is created
  useEffect(() => {
    if (activeNoteId && activeNote && !activeNote.title?.trim()) {
      setTimeout(() => titleInputRef.current?.focus(), 0);
    }
  }, [activeNoteId]);

  // Close move picker on outside click
  useEffect(() => {
    if (!movePicker) return;
    function handle(e: MouseEvent) {
      if (movePickerRef.current && !movePickerRef.current.contains(e.target as Node)) {
        setMovePicker(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [movePicker]);

  // Flush pending save on tab close (keepalive: true in api.ts ensures the request survives)
  useEffect(() => {
    function onBeforeUnload() {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (activeNoteId && activeNoteId > 0) {
        apiUpdateNote(activeNoteId, titleRef.current, bodyRef.current);
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeNoteId]);

  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: activeNote?.content ?? "",
      editorProps: {
        attributes: {
          style: [
            "font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            "font-size: 16px",
            "line-height: 1.65",
            "color: #1C1C1E",
            "outline: none",
            "min-height: 200px",
          ].join("; "),
          class: "gooni-note-editor",
        },
      },
      onUpdate: ({ editor }) => {
        bodyRef.current = editor.getHTML();
        scheduleSave();
      },
      onBlur: async () => {
        await save();
        embedAndCheck(activeNoteId);
      },
    },
    [activeNoteId]
  );

  useEffect(() => {
    if (editor && activeNote) {
      const current = editor.getHTML();
      const desired = activeNote.content ?? "";
      if (current !== desired) {
        editor.commands.setContent(desired);
      }
    }
  }, [activeNoteId, editor]);

  function scheduleSave() {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(save, 1500);
  }

  async function save() {
    if (!activeNoteId || activeNoteId < 0) return;
    setSaveStatus("saving");
    try {
      await updateNote(activeNoteId, titleRef.current, bodyRef.current);
      const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      setLastSavedTime(time);
      setSaveStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("idle");
    }
  }

  async function embedAndCheck(noteId: number | null) {
    if (!noteId || noteId < 0) return;
    const result = await apiEmbedNote(noteId);
    if (result.suggested_space_id) {
      setSpaceSuggestion(result);
    }
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setLocalTitle(val);
    titleRef.current = val;
    scheduleSave();
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      editor?.commands.focus();
    }
  }

  // Spaces the note can be moved to (all except the current one)
  const currentSpaceId = selectedSpaceId ?? "general";
  const moveTargets = spaces
    .map((s) => ({ id: String(s.id), name: s.name, emoji: s.id === "general" ? "📥" : (s.emoji ?? "🗂️") }))
    .filter((s) => s.id !== currentSpaceId);

  return (
    <div
      style={{
        flex: 1,
        height: "100vh",
        background: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      {/* Header bar — same height as Sidebar + NotesList headers */}
      <div
        style={{
          height: 52,
          padding: "0 20px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: saveStatus === "saving" ? "#8E8E93" : saveStatus === "saved" ? "#34C759" : "#8E8E93",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            transition: "color 0.2s",
          }}
        >
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "saved"
            ? `Saved ${lastSavedTime}`
            : activeNote
            ? formatNoteDate(activeNote.updated_at)
            : ""}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Space suggestion */}
          {spaceSuggestion?.suggested_space_id && activeNote?.space_id === null && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 14, background: "rgba(0,122,255,0.08)", fontSize: 12, color: "#007AFF", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
              <span>{spaceSuggestion.suggested_space_emoji ?? "🗂️"} {spaceSuggestion.suggested_space_name}?</span>
              <button
                onClick={() => { if (activeNoteId) moveNote(activeNoteId, currentSpaceId, String(spaceSuggestion.suggested_space_id)); setSpaceSuggestion(null); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#007AFF", fontWeight: 600, fontSize: 12, padding: 0 }}
              >Move</button>
              <button
                onClick={() => setSpaceSuggestion(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#8E8E93", fontSize: 13, padding: 0, lineHeight: 1 }}
              >×</button>
            </div>
          )}
          {/* Move to... button */}
          {activeNote && moveTargets.length > 0 && (
            <div ref={movePickerRef} style={{ position: "relative" }}>
              <button
                onClick={() => setMovePicker((p) => !p)}
                title="Move note to another space"
                style={{
                  padding: "4px 10px",
                  borderRadius: 14,
                  border: "none",
                  background: movePicker ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)",
                  cursor: "pointer",
                  fontSize: 12,
                  color: "#636366",
                  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.10)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = movePicker ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)")}
              >
                Move to ↗
              </button>
              {movePicker && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: 0,
                    background: "#FFFFFF",
                    borderRadius: 10,
                    boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
                    padding: 6,
                    minWidth: 160,
                    zIndex: 100,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                  }}
                >
                  {moveTargets.map((space) => (
                    <button
                      key={space.id}
                      onClick={() => {
                        if (activeNoteId) moveNote(activeNoteId, currentSpaceId, space.id);
                        setMovePicker(false);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "7px 10px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        borderRadius: 6,
                        fontSize: 13.5,
                        color: "#1C1C1E",
                        textAlign: "left",
                      }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
                    >
                      <span style={{ fontSize: 14 }}>{space.emoji}</span>
                      {space.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

        <button
          onClick={toggleJarvis}
          title={jarvisOpen ? "Close Jarvis" : "Open Jarvis"}
          style={{
            padding: "5px 12px",
            borderRadius: 16,
            border: "none",
            background: jarvisOpen ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)",
            cursor: "pointer",
            fontSize: 13,
            color: jarvisOpen ? "#1C1C1E" : "#636366",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            fontWeight: jarvisOpen ? 600 : 400,
            display: "flex",
            alignItems: "center",
            gap: 5,
            transition: "background 0.1s",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.10)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = jarvisOpen ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)")}
        >
          💬 Jarvis
        </button>
        </div>
      </div>

      {/* Editor content */}
      {!activeNote ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              color: "#AEAEB2",
              fontSize: 15,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            }}
          >
            Select a note or press + to create one
          </span>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "32px 48px",
            boxSizing: "border-box",
            maxWidth: 740,
            width: "100%",
            margin: "0 auto",
          }}
        >
          <input
            ref={titleInputRef}
            value={localTitle}
            onChange={handleTitleChange}
            onBlur={save}
            onKeyDown={handleTitleKeyDown}
            placeholder="Title"
            style={{
              display: "block",
              width: "100%",
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
              color: "#1C1C1E",
              border: "none",
              outline: "none",
              background: "transparent",
              marginBottom: 16,
              padding: 0,
              lineHeight: 1.3,
            }}
          />
          <EditorContent editor={editor} />

          {/* Related notes */}
          {relatedNotes.length > 0 && (
            <div style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>RELATED</p>
              {relatedNotes.map((n) => {
                const targetSpaceId = n.space_id ? String(n.space_id) : "general";
                return (
                  <button
                    key={n.id}
                    onClick={async () => { selectSpace(targetSpaceId); await loadNotes(targetSpaceId); selectNote(n.id); }}
                    style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", width: "100%", padding: "7px 0", background: "none", border: "none", cursor: "pointer", gap: 12, borderRadius: 6 }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "none")}
                  >
                    <span style={{ fontSize: 14, color: "#1C1C1E", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {n.title || "Untitled"}
                    </span>
                    <span style={{ fontSize: 12, color: "#AEAEB2", flexShrink: 0, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
                      {formatNoteDate(n.updated_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
