import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";

import { updateNote as apiUpdateNote, memorizeNote as apiMemorizeNote, touchNote as apiTouchNote, embedNote as apiEmbedNote, fetchRelatedNotes, patchNote as apiPatchNote, type ApiNote, type SpaceSuggestion } from "../../services/api";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useGooniStore } from "../../stores/useGooniStore";
import { useSpacesStore } from "../../stores/useSpacesStore";

function useEditorStyles() {
  useEffect(() => {
    let style = document.querySelector<HTMLStyleElement>("style[data-gooni-note-editor]");
    if (!style) {
      style = document.createElement("style");
      style.setAttribute("data-gooni-note-editor", "true");
      document.head.appendChild(style);
    }
    style.textContent = `
      .gooni-note-editor { outline: none; }
      .gooni-note-editor p { margin: 0 0 6px; }
      .gooni-note-editor ul,
      .gooni-note-editor ol { padding-left: 20px; margin: 0 0 6px; }
      .gooni-note-editor > p:first-child:empty::before {
        content: "Start writing...";
        color: #AEAEB2;
        pointer-events: none;
        float: left;
        height: 0;
      }
      .gooni-note-editor img {
        max-width: 100%;
        height: auto;
        border-radius: 6px;
        display: block;
        margin: 8px 0;
      }
      .gooni-note-editor img.ProseMirror-selectednode {
        outline: 2px solid #007AFF;
      }
      .gooni-note-editor ul[data-type="taskList"] {
        list-style: none;
        padding: 0;
        margin: 0 0 6px;
      }
      .gooni-note-editor ul[data-type="taskList"] li {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 2px;
      }
      .gooni-note-editor ul[data-type="taskList"] li > label {
        flex: 0 0 auto;
        margin: 0;
        padding: 0;
        user-select: none;
        -webkit-user-select: none;
        line-height: 1.65;
      }
      .gooni-note-editor ul[data-type="taskList"] li > label input[type="checkbox"] {
        width: 15px;
        height: 15px;
        cursor: pointer;
        accent-color: #1C1C1E;
        margin: 0;
        vertical-align: middle;
      }
      .gooni-note-editor ul[data-type="taskList"] li > div {
        flex: 1 1 auto;
        min-width: 0;
      }
      .gooni-note-editor ul[data-type="taskList"] li > div > p { margin: 0; }
      .gooni-note-editor ul[data-type="taskList"] li[data-checked="true"] > div {
        text-decoration: line-through;
        color: #AEAEB2;
      }
      .gooni-note-editor ul[data-type="taskList"] ul[data-type="taskList"] {
        margin: 2px 0 0;
      }
      .gooni-toolbar-btn { transition: background 0.1s; }
      .gooni-toolbar-btn:hover { background: rgba(0,0,0,0.05) !important; }
      .gooni-note-editor table {
        border-collapse: collapse;
        width: 100%;
        margin: 8px 0;
        font-size: 14px;
      }
      .gooni-note-editor table td,
      .gooni-note-editor table th {
        border: 1px solid rgba(0,0,0,0.12);
        padding: 6px 10px;
        min-width: 80px;
        vertical-align: top;
      }
      .gooni-note-editor table th {
        background: rgba(0,0,0,0.04);
        font-weight: 600;
      }
      .gooni-note-editor table .selectedCell {
        background: rgba(0,122,255,0.08);
      }
    `;
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

const TOOLBAR_ITEMS = [
  { label: "B",   title: "Bold",        cmd: (e: Editor | null) => e!.chain().focus().toggleBold().run(),              active: (e: Editor | null) => e!.isActive("bold"),             style: { fontWeight: 700 } },
  { label: "I",   title: "Italic",      cmd: (e: Editor | null) => e!.chain().focus().toggleItalic().run(),            active: (e: Editor | null) => e!.isActive("italic"),           style: { fontStyle: "italic" as const } },
  { label: "S",   title: "Strike",      cmd: (e: Editor | null) => e!.chain().focus().toggleStrike().run(),            active: (e: Editor | null) => e!.isActive("strike"),           style: { textDecoration: "line-through" as const } },
  null,
  { label: "H1",  title: "Heading 1",   cmd: (e: Editor | null) => e!.chain().focus().toggleHeading({ level: 1 }).run(), active: (e: Editor | null) => e!.isActive("heading", { level: 1 }), style: {} },
  { label: "H2",  title: "Heading 2",   cmd: (e: Editor | null) => e!.chain().focus().toggleHeading({ level: 2 }).run(), active: (e: Editor | null) => e!.isActive("heading", { level: 2 }), style: {} },
  null,
  { label: "•",   title: "Bullet list", cmd: (e: Editor | null) => e!.chain().focus().toggleBulletList().run(), active: (e: Editor | null) => e!.isActive("bulletList"), style: {} },
  { label: "☑",  title: "Task list",   cmd: (e: Editor | null) => e!.chain().focus().toggleTaskList().run(),   active: (e: Editor | null) => e!.isActive("taskList"),   style: {} },
  null,
  { label: "<>",  title: "Inline code", cmd: (e: Editor | null) => e!.chain().focus().toggleCode().run(),              active: (e: Editor | null) => e!.isActive("code"),             style: { fontFamily: "monospace", fontSize: "11px" } },
  { label: "```", title: "Code block",  cmd: (e: Editor | null) => e!.chain().focus().toggleCodeBlock().run(),         active: (e: Editor | null) => e!.isActive("codeBlock"),        style: { fontFamily: "monospace", fontSize: "10px" } },
  null,
  { label: "⊞",  title: "Table",       cmd: (e: Editor | null) => e!.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), active: () => false, style: {} },
] as const;

function FormatToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 1, marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid rgba(0,0,0,0.06)", flexWrap: "wrap" }}>
      {TOOLBAR_ITEMS.map((item, i) =>
        item === null ? (
          <div key={i} style={{ width: 1, height: 13, background: "rgba(0,0,0,0.1)", margin: "0 3px" }} />
        ) : (
          <button
            key={item.label}
            title={item.title}
            className="gooni-toolbar-btn"
            onMouseDown={(e) => { e.preventDefault(); item.cmd(editor); }}
            style={{
              padding: "3px 7px", borderRadius: 5, border: "none",
              background: item.active(editor) ? "rgba(0,0,0,0.09)" : "transparent",
              color: item.active(editor) ? "#1C1C1E" : "#636366",
              fontSize: 12, cursor: "pointer",
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              ...item.style,
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

export function NoteEditor() {
  useEditorStyles();

  const { selectedSpaceId, notes, activeNoteId, updateNote, moveNote, selectNote, loadNotes, selectSpace, deleteNote } = useNotesContentStore();
  const { isOpen: gooniOpen, toggle: toggleGooni } = useGooniStore();
  const { spaces } = useSpacesStore();

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  const [localTitle, setLocalTitle] = useState(activeNote?.title ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [movePicker, setMovePicker] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [relatedNotes, setRelatedNotes] = useState<ApiNote[]>([]);
  const [spaceSuggestion, setSpaceSuggestion] = useState<SpaceSuggestion | null>(null);
  const [localIsPublic, setLocalIsPublic] = useState<boolean>(activeNote?.is_public ?? false);
  const movePickerRef = useRef<HTMLDivElement>(null);
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const bodyRef = useRef<string>(activeNote?.content ?? "");
  const titleRef = useRef<string>(activeNote?.title ?? "");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveNoteId = useRef<number | null>(activeNoteId);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const hasChanges = useRef(false);

  useEffect(() => {
    // Flush any unsaved changes (e.g. a dropped image) before leaving the previous note
    const prevId = prevActiveNoteId.current;
    if (hasChanges.current && prevId && prevId > 0 && prevId !== activeNoteId) {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      updateNote(prevId, titleRef.current, bodyRef.current).catch(() => {});
    }

    setLocalTitle(activeNote?.title ?? "");
    bodyRef.current = activeNote?.content ?? "";
    titleRef.current = activeNote?.title ?? "";
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaveStatus("idle");
    setLastSavedTime(null);
    setSpaceSuggestion(null);
    setRelatedNotes([]);
    setDeleteConfirm(false);
    setLocalIsPublic(activeNote?.is_public ?? false);
    hasChanges.current = false;
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
      if (activeNoteId && activeNoteId > 0 && hasChanges.current) {
        apiUpdateNote(activeNoteId, titleRef.current, bodyRef.current);
        if (useNotesContentStore.getState().isDirty) {
          apiMemorizeNote(activeNoteId);
        }
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeNoteId]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Image.extend({ selectable: true }).configure({ inline: false, allowBase64: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
      ],
      content: activeNote?.content ?? "",
      editorProps: {
        attributes: {
          style: [
            "font-family: 'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
        hasChanges.current = true;
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
    if (!hasChanges.current) return;
    setSaveStatus("saving");
    try {
      await updateNote(activeNoteId, titleRef.current, bodyRef.current);
      hasChanges.current = false;
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
    try {
      const result = await apiEmbedNote(noteId);
      if (result.suggested_space_id) {
        setSpaceSuggestion(result);
      }
    } catch {
      // note may have been deleted — ignore
    }
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setLocalTitle(val);
    titleRef.current = val;
    hasChanges.current = true;
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
            fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 14, background: "rgba(0,122,255,0.08)", fontSize: 12, color: "#007AFF", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
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
                  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
                    fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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

          {/* Delete button */}
          {activeNote && activeNote.id > 0 && (
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setDeleteConfirm((p) => !p)}
                title="Delete note"
                style={{
                  padding: "4px 10px", borderRadius: 14, border: "none",
                  background: deleteConfirm ? "rgba(255,59,48,0.10)" : "rgba(0,0,0,0.05)",
                  cursor: "pointer", fontSize: 12,
                  color: deleteConfirm ? "#FF3B30" : "#636366",
                  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                  display: "flex", alignItems: "center", gap: 4,
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,59,48,0.10)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = deleteConfirm ? "rgba(255,59,48,0.10)" : "rgba(0,0,0,0.05)")}
              >
                🗑 Delete
              </button>
              {deleteConfirm && (
                <div style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  background: "#FFFFFF", borderRadius: 10,
                  boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
                  padding: 6, minWidth: 160, zIndex: 100,
                  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                }}>
                  <div style={{ padding: "6px 10px 8px", fontSize: 12.5, color: "#636366" }}>
                    Delete this note?
                  </div>
                  <button
                    onClick={async () => {
                      await deleteNote(activeNote.id, selectedSpaceId ?? "general");
                      setDeleteConfirm(false);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 13.5, color: "#FF3B30", textAlign: "left" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,59,48,0.08)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
                  >
                    Yes, delete
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(false)}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 13.5, color: "#636366", textAlign: "left" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

        <button
          onClick={toggleGooni}
          title={gooniOpen ? "Close Gooni" : "Open Gooni"}
          style={{
            padding: "5px 12px",
            borderRadius: 16,
            border: "none",
            background: gooniOpen ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)",
            cursor: "pointer",
            fontSize: 13,
            color: gooniOpen ? "#1C1C1E" : "#636366",
            fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
            fontWeight: gooniOpen ? 600 : 400,
            display: "flex",
            alignItems: "center",
            gap: 5,
            transition: "background 0.1s",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.10)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = gooniOpen ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)")}
        >
          💬 Gooni
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
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "#1C1C1E",
              border: "none",
              outline: "none",
              background: "transparent",
              marginBottom: 16,
              padding: 0,
              lineHeight: 1.3,
            }}
          />
          {/* Format toolbar */}
          <FormatToolbar editor={editor} />

          {/* Public toggle */}
          <div style={{ marginBottom: 16 }}>
            <button
              onClick={() => {
                if (!activeNoteId || activeNoteId < 0) return;
                const next = !localIsPublic;
                setLocalIsPublic(next);
                apiPatchNote(activeNoteId, { is_public: next }).catch(() => {});
              }}
              style={{
                padding: "3px 10px",
                borderRadius: 20,
                border: `1px solid ${localIsPublic ? "#34C759" : "rgba(0,0,0,0.15)"}`,
                background: localIsPublic ? "#34C759" : "transparent",
                color: localIsPublic ? "#fff" : "#636366",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              🌐 Public
            </button>
          </div>
          {editor && (
            <BubbleMenu
              editor={editor}
              style={{
                display: "flex",
                background: "#1C1C1E",
                borderRadius: 8,
                padding: "3px 4px",
                gap: 1,
                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
              }}
            >
              {[
                { label: "B", title: "Bold", action: () => editor.chain().focus().toggleBold().run(), active: editor.isActive("bold"), style: { fontWeight: 700 } },
                { label: "I", title: "Italic", action: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive("italic"), style: { fontStyle: "italic" } },
                { label: "S", title: "Strikethrough", action: () => editor.chain().focus().toggleStrike().run(), active: editor.isActive("strike"), style: { textDecoration: "line-through" } },
                { label: "H1", title: "Heading 1", action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(), active: editor.isActive("heading", { level: 1 }), style: {} },
                { label: "H2", title: "Heading 2", action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), active: editor.isActive("heading", { level: 2 }), style: {} },
                { label: "•", title: "Bullet list", action: () => editor.chain().focus().toggleBulletList().run(), active: editor.isActive("bulletList"), style: {} },
                { label: "☑", title: "Task list", action: () => editor.chain().focus().toggleTaskList().run(), active: editor.isActive("taskList"), style: {} },
                { label: "`", title: "Inline code", action: () => editor.chain().focus().toggleCode().run(), active: editor.isActive("code"), style: { fontFamily: "monospace" } },
              ].map(({ label, title, action, active, style }) => (
                <button
                  key={label}
                  title={title}
                  onMouseDown={(e) => { e.preventDefault(); action(); }}
                  style={{
                    padding: "4px 7px",
                    borderRadius: 5,
                    border: "none",
                    background: active ? "rgba(255,255,255,0.18)" : "transparent",
                    color: active ? "#fff" : "rgba(255,255,255,0.7)",
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                    ...style,
                  }}
                >
                  {label}
                </button>
              ))}

              {/* Divider */}
              <div style={{ width: 1, background: "rgba(255,255,255,0.15)", margin: "4px 2px" }} />

              {/* Insert table */}
              <button
                title="Insert table"
                onMouseDown={(e) => {
                  e.preventDefault();
                  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
                }}
                style={{ padding: "4px 7px", borderRadius: 5, border: "none", background: "transparent", color: "rgba(255,255,255,0.7)", fontSize: 11, cursor: "pointer" }}
              >
                ⊞ table
              </button>
            </BubbleMenu>
          )}

          <div
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
                f.type.startsWith("image/")
              );
              if (!files.length || !editor) return;
              e.preventDefault();
              files.forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") {
                    editor.chain().focus().setImage({ src: reader.result }).run();
                    hasChanges.current = true;
                    scheduleSave();
                  }
                };
                reader.readAsDataURL(file);
              });
            }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith("image/"))) {
                e.preventDefault();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
                f.type.startsWith("image/")
              );
              if (!files.length || !editor) return;
              e.preventDefault();
              files.forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") {
                    editor.chain().focus().setImage({ src: reader.result }).run();
                    hasChanges.current = true;
                    scheduleSave();
                  }
                };
                reader.readAsDataURL(file);
              });
            }}
          >
            <EditorContent editor={editor} />
          </div>

          {/* Related notes */}
          {relatedNotes.length > 0 && (
            <div style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>RELATED</p>
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
                    <span style={{ fontSize: 14, color: "#1C1C1E", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {n.title || "Untitled"}
                    </span>
                    <span style={{ fontSize: 12, color: "#AEAEB2", flexShrink: 0, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
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
