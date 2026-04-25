import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold as BoldIcon, Italic as ItalicIcon, Strikethrough, Code as CodeIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SlashCommand } from "./slash-command";
import { createNote as apiCreateNote, updateNote as apiUpdateNote, memorizeNote as apiMemorizeNote, touchNote as apiTouchNote, embedNote as apiEmbedNote, fetchRelatedNotes, patchNote as apiPatchNote, suggestNoteQuestions, type ApiNote, type SpaceSuggestion } from "../../services/api";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useGooniStore } from "../../stores/useGooniStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { GooniLogo } from "../GooniLogo";
import { SpaceIcon } from "./SpaceIcon";

type Variant = "full" | "embedded";

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
      .gooni-note-editor p { margin: 0 0 12px; }
      .gooni-note-editor h1 { font-size: 1.7em; font-weight: 700; line-height: 1.25; margin: 1.4em 0 0.5em; letter-spacing: -0.01em; }
      .gooni-note-editor h2 { font-size: 1.35em; font-weight: 700; line-height: 1.3; margin: 1.2em 0 0.4em; letter-spacing: -0.005em; }
      .gooni-note-editor h3 { font-size: 1.15em; font-weight: 600; line-height: 1.35; margin: 1em 0 0.4em; }
      .gooni-note-editor h1:first-child,
      .gooni-note-editor h2:first-child,
      .gooni-note-editor h3:first-child { margin-top: 0; }
      .gooni-note-editor blockquote { border-left: 3px solid rgba(0,0,0,0.10); padding-left: 14px; color: #475569; margin: 12px 0; }
      .gooni-note-editor code { background: rgba(15,23,42,0.06); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
      .gooni-note-editor pre { background: #0F172A; color: #F1F5F9; padding: 14px 16px; border-radius: 8px; margin: 12px 0; overflow-x: auto; }
      .gooni-note-editor pre code { background: transparent; padding: 0; color: inherit; font-size: 0.92em; }
      .gooni-note-editor ul,
      .gooni-note-editor ol { padding-left: 22px; margin: 0 0 12px; }
      .gooni-note-editor li > p { margin: 0 0 4px; }
      .gooni-note-editor.is-empty > p:first-child { position: relative; }
      .gooni-note-editor.is-empty > p:first-child::before {
        content: "Start writing — press '/' for blocks";
        color: #AEAEB2;
        pointer-events: none;
        position: absolute;
        top: 0;
        left: 0;
      }
      ${import.meta.env.DEV ? `
      .gooni-note-editor.is-empty > p:first-child::after {
        content: "[THIS IS DEV]";
        color: #FF3B30;
        font-weight: 600;
        font-size: 0.75em;
        letter-spacing: 0.5px;
        pointer-events: none;
        position: absolute;
        top: 0.25em;
        right: 0;
      }
      ` : ""}
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
      /* (Hover glow removed — the warm-yellow pointer-tracking light on the
         embedded quick-note input was too busy. Class stays on the element
         for layout-ordering purposes but has no visual effect now.) */
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

function formatShortDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

type SaveStatus = "idle" | "saving" | "saved";

interface NoteEditorProps {
  variant?: Variant;
  onSubmitted?: (note: ApiNote | null, buttonRect: DOMRect | null) => void;
  // When set in embedded mode, the submit path patches THIS note's content
  // instead of creating a new one. Used by the Plan-from-todo flow where
  // the plan note already exists on the backend.
  submitToNoteId?: number;
  // Fires when the editor's empty state changes — lets parents react to
  // "user started typing" without reading editor internals.
  onEmptyChange?: (empty: boolean) => void;
}

export function NoteEditor({ variant = "full", onSubmitted, submitToNoteId, onEmptyChange }: NoteEditorProps = {}) {
  useEditorStyles();
  const embedded = variant === "embedded";

  const { selectedSpaceId, notes, activeNoteId, updateNote, moveNote, selectNote, loadNotes, selectSpace, deleteNote } = useNotesContentStore();
  const { isOpen: gooniOpen, toggle: toggleGooni } = useGooniStore();
  const { spaces } = useSpacesStore();

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  const [localTitle, setLocalTitle] = useState(activeNote?.title ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [movePicker, setMovePicker] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [relatedNotes, setRelatedNotes] = useState<ApiNote[]>([]);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [spaceSuggestion, setSpaceSuggestion] = useState<SpaceSuggestion | null>(null);
  const [localIsPublic, setLocalIsPublic] = useState<boolean>(activeNote?.is_public ?? false);
  const movePickerRef = useRef<HTMLDivElement>(null);
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<string>(activeNote?.content ?? "");
  const titleRef = useRef<string>(activeNote?.title ?? "");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevActiveNoteId = useRef<number | null>(activeNoteId);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const hasChanges = useRef(false);
  // Embedded mode is ephemeral: no server note is created until the user submits.
  // Ref so handleKeyDown (captured once inside useEditor) always calls the latest handleSubmit.
  const handleSubmitRef = useRef<() => Promise<void>>(async () => {});

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
    setSuggestedQuestions([]);
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
        SlashCommand,
      ],
      content: activeNote?.content ?? "",
      autofocus: embedded ? "end" : false,
      editorProps: {
        attributes: {
          style: [
            "font-family: 'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
            embedded ? "font-size: 14.5px" : "font-size: 17px",
            embedded ? "line-height: 1.65" : "line-height: 1.75",
            "color: #1C1C1E",
            "outline: none",
            embedded ? "min-height: 80px" : "min-height: 200px",
          ].join("; "),
          class: "gooni-note-editor",
        },
        handleKeyDown: (_view, event) => {
          if (embedded && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void handleSubmitRef.current();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor }) => {
        bodyRef.current = editor.getHTML();
        hasChanges.current = true;
        setEditorEmpty(editor.isEmpty);
        onEmptyChange?.(editor.isEmpty);
        // Embedded quick-note is ephemeral — no debounced save. Everything persists on submit.
        if (!embedded) scheduleSave();
      },
      onBlur: async () => {
        // Embedded: ephemeral, no save on blur — content persists only on submit.
        if (embedded) return;
        await save();
        embedAndCheck(activeNoteId);
      },
    },
    [activeNoteId]
  );

  // Keep editorEmpty in sync when switching notes
  useEffect(() => {
    if (editor) setEditorEmpty(editor.isEmpty);
  }, [editor, activeNoteId]);

  // Toggle .is-empty on the editor DOM so the placeholder CSS tracks real emptiness
  // (not CSS :empty, which breaks the moment ProseMirror inserts a trailing <br>)
  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom as HTMLElement;
    el.classList.toggle("is-empty", editorEmpty);
  }, [editor, editorEmpty]);

  async function handleSubmit() {
    if (!editor || editor.isEmpty) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    // Capture the rect BEFORE any state mutation so the ink animation has the right origin.
    const buttonRect = submitButtonRef.current?.getBoundingClientRect() ?? null;
    const contentToSave = bodyRef.current;
    let savedNote: ApiNote | null = null;

    if (embedded && submitToNoteId) {
      // Plan-from-todo path: the note already exists (title was set by
      // POST /todos/{id}/plan). We only need to PATCH in the body content.
      try {
        savedNote = await apiPatchNote(submitToNoteId, { content: contentToSave });
      } catch {
        // silent
      }
      editor.commands.clearContent();
      bodyRef.current = "";
      hasChanges.current = false;
      setEditorEmpty(true);
      onEmptyChange?.(true);
    } else if (embedded && !activeNoteId) {
      // Ephemeral quick-note path: create the note server-side NOW with the final content.
      try {
        savedNote = await apiCreateNote("general", { content: contentToSave });
      } catch {
        // silent — animation/refresh will no-op
      }
      // Reset editor for the next quick note; keep authoring mode so it stays open + focused.
      editor.commands.clearContent();
      bodyRef.current = "";
      hasChanges.current = false;
      setEditorEmpty(true);
      onEmptyChange?.(true);
      editor.commands.focus("end");
    } else if (activeNoteId && activeNoteId > 0) {
      // Existing full-variant / already-created path.
      try {
        await updateNote(activeNoteId, titleRef.current, contentToSave);
        hasChanges.current = false;
        for (const list of Object.values(useNotesContentStore.getState().notes)) {
          const n = list.find((x) => x.id === activeNoteId);
          if (n) { savedNote = n; break; }
        }
      } catch {
        // swallow
      }
      selectNote(null);
      setEditorEmpty(true);
      editor.commands.clearContent();
    }

    onSubmitted?.(savedNote, buttonRect);
  }

  // Keep handleSubmitRef current so the editor's once-captured handleKeyDown always calls fresh state.
  handleSubmitRef.current = handleSubmit;

  // Sync editor + local refs from activeNote. Deps include activeNote.content/title so we
  // catch the common case where a note is selected BEFORE its space has loaded — activeNote
  // starts null, then arrives async via loadNotes. The hasChanges guard prevents clobbering
  // the user's in-progress typing when a save round-trip updates the store.
  useEffect(() => {
    if (!editor || !activeNote || hasChanges.current) return;
    const desired = activeNote.content ?? "";
    if (editor.getHTML() !== desired) {
      editor.commands.setContent(desired);
      bodyRef.current = desired;
    }
    const title = activeNote.title ?? "";
    if (titleRef.current !== title) {
      setLocalTitle(title);
      titleRef.current = title;
    }
    setLocalIsPublic(activeNote.is_public ?? false);
  }, [activeNoteId, editor, activeNote?.content, activeNote?.title, activeNote?.is_public]);

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
    // Generate probing questions in parallel — only fires LLM call when the
    // note is substantive enough (server-side gate at ~200 chars plaintext).
    try {
      const plain = bodyRef.current.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (plain.length >= 200) {
        const qs = await suggestNoteQuestions(noteId);
        setSuggestedQuestions(qs);
      } else {
        setSuggestedQuestions([]);
      }
    } catch {
      // non-fatal — questions are a nice-to-have, never block the note flow
    }
  }

  function askGooni(question: string) {
    const { newChat, send } = useConversationsStore.getState();
    newChat();
    if (!gooniOpen) toggleGooni();
    // Pass the active note's body as context so Gooni's reply stays grounded.
    send(question, bodyRef.current).catch(console.error);
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

  // Spaces the note can be moved to (all except the current one).
  // `emoji` is the raw stored value (may be `lucide:Folder`, a legacy emoji, or null).
  // `isInbox` flags the General space so the row can render an Inbox icon instead.
  const currentSpaceId = selectedSpaceId ?? "general";
  const moveTargets = spaces
    .map((s) => ({
      id: String(s.id), name: s.name,
      emoji: s.id === "general" ? "lucide:Inbox" : s.emoji,
    }))
    .filter((s) => s.id !== currentSpaceId);

  async function handleTogglePin() {
    if (!activeNote || !activeNoteId || activeNoteId < 0) return;
    const newPinned = !activeNote.is_pinned;
    try {
      await apiPatchNote(activeNoteId, { is_pinned: newPinned });
      // Optimistically update the note in every cached space list so activeNote.is_pinned flips immediately
      useNotesContentStore.setState((s) => {
        const updated: Record<string, ApiNote[]> = {};
        for (const [k, list] of Object.entries(s.notes)) {
          updated[k] = list.map((n) => (n.id === activeNoteId ? { ...n, is_pinned: newPinned } : n));
        }
        return { notes: updated };
      });
      usePinnedVersionStore.getState().bump();
    } catch (e) {
      console.error("pin toggle failed", e);
    }
  }

  return (
    <div
      style={
        embedded
          ? {
              background: "#FFFFFF",
              border: "1px solid rgba(0,0,0,0.07)",
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              position: "relative",
            }
          : {
              flex: 1,
              height: "100vh",
              background: "#FFFFFF",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              minWidth: 0,
            }
      }
    >
      {/* Header bar — full variant only */}
      {!embedded && (
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
            ? `Created ${formatShortDate(activeNote.created_at)} · Updated ${formatNoteDate(activeNote.updated_at)}`
            : ""}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Space suggestion */}
          {spaceSuggestion?.suggested_space_id && activeNote?.space_id === null && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 14, background: "rgba(0,122,255,0.08)", fontSize: 12, color: "#007AFF", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
              <SpaceIcon emoji={spaceSuggestion.suggested_space_emoji} size={13} color="#007AFF" />
              <span>{spaceSuggestion.suggested_space_name}?</span>
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
                  width: 30, height: 30, borderRadius: 8,
                  border: "none",
                  background: movePicker ? "rgba(0,0,0,0.08)" : "transparent",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "#636366",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0, flexShrink: 0,
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { if (!movePicker) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
                onMouseLeave={(e) => { if (!movePicker) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                ↗
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
                      <SpaceIcon emoji={space.emoji} size={14} />
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
                  width: 30, height: 30, borderRadius: 8, border: "none",
                  background: deleteConfirm ? "rgba(255,59,48,0.10)" : "transparent",
                  cursor: "pointer", fontSize: 13,
                  color: deleteConfirm ? "#FF3B30" : "#636366",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: 0, flexShrink: 0,
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { if (!deleteConfirm) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,59,48,0.08)"; }}
                onMouseLeave={(e) => { if (!deleteConfirm) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                🗑
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

        {/* Pin toggle — surfaces the current note in the sidebar's Pinned section */}
        {activeNote && activeNoteId && activeNoteId > 0 && (
          <button
            onClick={handleTogglePin}
            title={activeNote.is_pinned ? "Unpin from sidebar" : "Pin to sidebar"}
            style={{
              width: 30, height: 30, borderRadius: 8,
              border: "none",
              background: activeNote.is_pinned ? "rgba(255,176,32,0.14)" : "transparent",
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0, flexShrink: 0,
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => { if (!activeNote.is_pinned) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
            onMouseLeave={(e) => { if (!activeNote.is_pinned) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <span style={{
              fontSize: 13, lineHeight: 1,
              filter: activeNote.is_pinned ? "none" : "grayscale(1) opacity(0.5)",
              transition: "filter 0.15s",
            }}>📌</span>
          </button>
        )}

        {/* Public toggle — same visual family as Pin: icon-only with colored background when active */}
        {activeNote && activeNoteId && activeNoteId > 0 && (
          <button
            onClick={() => {
              if (!activeNoteId || activeNoteId < 0) return;
              const next = !localIsPublic;
              setLocalIsPublic(next);
              apiPatchNote(activeNoteId, { is_public: next }).catch(() => {});
            }}
            title={localIsPublic ? "Unpublish from public portfolio" : "Publish to public portfolio"}
            style={{
              width: 30, height: 30, borderRadius: 8,
              border: "none",
              background: localIsPublic ? "rgba(52,199,89,0.16)" : "transparent",
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0, flexShrink: 0,
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => { if (!localIsPublic) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
            onMouseLeave={(e) => { if (!localIsPublic) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <span style={{
              fontSize: 13, lineHeight: 1,
              filter: localIsPublic ? "none" : "grayscale(1) opacity(0.5)",
              transition: "filter 0.15s",
            }}>🌐</span>
          </button>
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
          <GooniLogo size={14} />
          Chat with Gooni
        </button>
        </div>
      </div>
      )}

      {/* Editor content */}
      {embedded ? (
        <div
          className="gooni-note-glow"
          onMouseMove={(e) => {
            const el = e.currentTarget;
            const rect = el.getBoundingClientRect();
            el.style.setProperty("--glow-x", `${e.clientX - rect.left}px`);
            el.style.setProperty("--glow-y", `${e.clientY - rect.top}px`);
          }}
          style={{
            position: "relative",
            padding: "18px 22px",
            boxSizing: "border-box",
            width: "100%",
            minHeight: 80 + 18 * 2,
            overflow: "hidden",
            borderRadius: 14,
          }}
        >
            <div
              style={{ position: "relative", zIndex: 1 }}
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

            <button
              ref={submitButtonRef}
              onClick={handleSubmit}
              disabled={editorEmpty}
              title="Submit (Enter)"
              style={{
                position: "absolute",
                bottom: 10,
                right: 10,
                width: 30, height: 30, borderRadius: "50%",
                border: "none",
                background: editorEmpty ? "rgba(0,0,0,0.06)" : "#1C1C1E",
                color: editorEmpty ? "#C7C7CC" : "#fff",
                cursor: editorEmpty ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0,
                transition: "background 0.25s ease, color 0.25s ease, transform 0.2s ease, box-shadow 0.25s ease",
                transform: editorEmpty ? "scale(0.92)" : "scale(1)",
                // Active state borrows the goon's green accent for a subtle glow.
                boxShadow: editorEmpty
                  ? "none"
                  : "0 2px 8px rgba(28,28,30,0.28), 0 0 0 1px rgba(74,222,128,0.35)",
              }}
              onMouseEnter={(e) => {
                if (editorEmpty) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.transform = "scale(1.08)";
                el.style.boxShadow = "0 3px 14px rgba(74,222,128,0.35), 0 0 0 1px rgba(74,222,128,0.55)";
              }}
              onMouseLeave={(e) => {
                if (editorEmpty) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.transform = "scale(1)";
                el.style.boxShadow = "0 2px 8px rgba(28,28,30,0.28), 0 0 0 1px rgba(74,222,128,0.35)";
              }}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 10.5 L6.5 3 M3 6.5 L6.5 3 L10 6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          style={{ flex: 1, overflowY: "auto", boxSizing: "border-box", width: "100%" }}
        >
          <div style={{ maxWidth: 740, width: "100%", margin: "0 auto", padding: "32px 48px", boxSizing: "border-box" }}>
            {!activeNote && (
              <div
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  minHeight: "70vh", textAlign: "center", color: "#AEAEB2",
                  fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                }}
              >
                <div style={{ fontSize: 28, marginBottom: 12 }}>📝</div>
                <div style={{ fontSize: 15, color: "#8E8E93", marginBottom: 4 }}>No note selected</div>
                <div style={{ fontSize: 13, color: "#C7C7CC" }}>
                  Pick one from the list, or press <kbd style={{ padding: "1px 5px", borderRadius: 4, background: "rgba(0,0,0,0.06)", fontSize: 12, fontFamily: "inherit" }}>⌘N</kbd> to start a new one.
                </div>
              </div>
            )}
            {activeNote && (
              <div style={{ minHeight: "75vh" }}>
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
                {editor && (
                  <BubbleMenu
                    editor={editor}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      background: "#1C1C1E",
                      borderRadius: 8,
                      padding: "3px 4px",
                      gap: 1,
                      boxShadow: "0 6px 22px rgba(0,0,0,0.22)",
                    }}
                  >
                    {/* Inline marks only — block-level conversions (H1/H2/lists/quote/code/table)
                        live in the slash menu now, which is the cleaner Confluence-style split. */}
                    {([
                      { Icon: BoldIcon,      title: "Bold",        action: () => editor.chain().focus().toggleBold().run(),    active: editor.isActive("bold") },
                      { Icon: ItalicIcon,    title: "Italic",      action: () => editor.chain().focus().toggleItalic().run(),  active: editor.isActive("italic") },
                      { Icon: Strikethrough, title: "Strike",      action: () => editor.chain().focus().toggleStrike().run(),  active: editor.isActive("strike") },
                      { Icon: CodeIcon,      title: "Inline code", action: () => editor.chain().focus().toggleCode().run(),    active: editor.isActive("code") },
                    ] as const).map((item) => (
                      <button
                        key={item.title}
                        title={item.title}
                        onMouseDown={(e) => { e.preventDefault(); item.action(); }}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          width: 26, height: 26,
                          padding: 0,
                          borderRadius: 5,
                          border: "none",
                          background: item.active ? "rgba(255,255,255,0.18)" : "transparent",
                          color: item.active ? "#fff" : "rgba(255,255,255,0.78)",
                          cursor: "pointer",
                          transition: "background 0.1s, color 0.1s",
                        }}
                      >
                        <item.Icon size={14} strokeWidth={1.9} />
                      </button>
                    ))}
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

                {suggestedQuestions.length > 0 && (
                  <div style={{ marginTop: relatedNotes.length > 0 ? 28 : 48, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                      QUESTIONS GOONI WOULD ASK
                    </p>
                    {suggestedQuestions.map((q, i) => (
                      <button
                        key={i}
                        onClick={() => askGooni(q)}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", marginBottom: 6, background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.05)", borderRadius: 8, cursor: "pointer", fontSize: 13.5, color: "#1C1C1E", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", lineHeight: 1.5 }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.025)")}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
