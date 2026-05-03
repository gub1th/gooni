import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { BubbleMenu } from "@tiptap/react/menus";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold as BoldIcon, Italic as ItalicIcon, Strikethrough, Code as CodeIcon,
  Trash2, FolderInput, Pin as PinIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { SlashCommand } from "./slash-command";
import { NoteLink } from "./NoteLinkExtension";
import { createNote as apiCreateNote, updateNote as apiUpdateNote, memorizeNote as apiMemorizeNote, touchNote as apiTouchNote, embedNote as apiEmbedNote, fetchNote as apiFetchNote, fetchRelatedNotes, fetchNoteMemories, patchNote as apiPatchNote, suggestNoteQuestions, extractToChildNote as apiExtractToChildNote, type ApiNote, type ApiMemory, type RelatedNote, type NoteClassifySignals, type SpaceSuggestion } from "../../services/api";
import { DOMSerializer } from "@tiptap/pm/model";
import { CornerUpRight } from "lucide-react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useGooniStore } from "../../stores/useGooniStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { Tooltip } from "../Tooltip";
import { SpaceIcon } from "./SpaceIcon";
import { displayTitle } from "../../utils/notePreview";

type Variant = "full" | "embedded";

// Block image insertion helper. Always trails the image with an empty
// paragraph so the cursor has a text-block to land in even when the image
// is the very first node of an otherwise-empty document. Without the
// trailing paragraph, TipTap with `inline: false` leaves the doc as a
// lone block image and a follow-up focus() lands nowhere — surfaced as a
// console error and a save-status flicker the first time you drop/paste
// an image into a fresh note.
function insertImageBlock(editor: Editor, src: string) {
  editor
    .chain()
    .focus()
    .insertContent([
      { type: "image", attrs: { src } },
      { type: "paragraph" },
    ])
    .run();
}

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
      /* Nested list styles — Tab/Shift-Tab in TipTap sinks/lifts list items.
         Use a different marker per depth so the indent is visually obvious:
         ordered: 1, a, i, 1, a, i …
         unordered: disc, circle, square, disc, circle, square … */
      .gooni-note-editor ol { list-style-type: decimal; }
      .gooni-note-editor ol ol { list-style-type: lower-alpha; }
      .gooni-note-editor ol ol ol { list-style-type: lower-roman; }
      .gooni-note-editor ol ol ol ol { list-style-type: decimal; }
      .gooni-note-editor ul { list-style-type: disc; }
      .gooni-note-editor ul ul { list-style-type: circle; }
      .gooni-note-editor ul ul ul { list-style-type: square; }
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
      /* Extracted-to-child note chip — inline pill, click navigates to child. */
      .gooni-note-editor a.gooni-note-link {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 8px;
        margin: 0 2px;
        background: rgba(74,222,128,0.10);
        color: #16803C;
        border: 0.5px solid rgba(22,128,60,0.25);
        border-radius: 12px;
        font-size: 0.88em;
        text-decoration: none;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
      }
      .gooni-note-editor a.gooni-note-link:hover {
        background: rgba(74,222,128,0.18);
        border-color: rgba(22,128,60,0.45);
      }
      .gooni-note-editor a.gooni-note-link.ProseMirror-selectednode {
        outline: 2px solid #007AFF;
        outline-offset: 1px;
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

// Subtle tint per memory type so the pill row reads like a legend without
// needing an actual key. Pulls from the same palette as the /memories page.
function memoryTint(type: string): { bg: string; fg: string; border: string } {
  switch (type) {
    case "preference": return { bg: "#FFF7ED", fg: "#9A3412", border: "rgba(154,52,18,0.20)" };
    case "goal":       return { bg: "#EEF2FF", fg: "#3730A3", border: "rgba(55,48,163,0.20)" };
    case "fact":       return { bg: "#F1F5F9", fg: "#334155", border: "rgba(51,65,85,0.18)" };
    case "routine":    return { bg: "#ECFDF5", fg: "#065F46", border: "rgba(6,95,70,0.20)" };
    case "constraint": return { bg: "#FEF2F2", fg: "#991B1B", border: "rgba(153,27,27,0.20)" };
    case "episode":    return { bg: "#FAF5FF", fg: "#6B21A8", border: "rgba(107,33,168,0.20)" };
    default:           return { bg: "#F4F4F5", fg: "#52525B", border: "rgba(82,82,91,0.18)" };
  }
}

// Cosine similarity score → yellow (low) → green (high) gradient. Score is
// clamped 0..1 by the caller; we map to two anchor points and lerp.
function similarityTint(score: number): { bg: string; fg: string } {
  // Yellow: hsl(45, 95%, 55%). Green: hsl(140, 60%, 42%).
  const t = Math.max(0, Math.min(1, score));
  const hue = 45 + (140 - 45) * t;
  const sat = 95 - (95 - 60) * t;
  const lit = 55 - (55 - 42) * t;
  const bg = `hsl(${hue}, ${sat}%, ${Math.min(92, lit + 38)}%)`;
  const fg = `hsl(${hue}, ${sat - 15}%, ${Math.max(22, lit - 18)}%)`;
  return { bg, fg };
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

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface NoteEditorProps {
  variant?: Variant;
  onSubmitted?: (note: ApiNote | null, buttonRect: DOMRect | null) => void;
  // Fires when the editor's empty state changes — lets parents react to
  // "user started typing" without reading editor internals.
  onEmptyChange?: (empty: boolean) => void;
}

export function NoteEditor({ variant = "full", onSubmitted, onEmptyChange }: NoteEditorProps = {}) {
  useEditorStyles();
  const embedded = variant === "embedded";

  const { selectedSpaceId, notes, activeNoteId, updateNote, refetchNote, moveNote, selectNote, loadNotes, selectSpace, deleteNote } = useNotesContentStore();
  const { isOpen: gooniOpen, toggle: toggleGooni } = useGooniStore();
  const { spaces } = useSpacesStore();
  const navigate = useNavigate();
  const [signalsExpanded, setSignalsExpanded] = useState(false);
  // Surface for the embedded composer — the last submitted note's classify
  // result. Embedded variant doesn't render the title/disclosure block, so
  // we shadow a small pill underneath the composer. Cleared on next submit.
  const [embeddedToast, setEmbeddedToast] = useState<{ noteId: number; signals: NoteClassifySignals } | null>(null);
  // Drives the slide-in / slide-out transform on the toast pill. Decoupled
  // from `embeddedToast` so we can render the pill, animate it in, hold,
  // animate it out, then unmount — without flashing on initial mount.
  const [embeddedToastVisible, setEmbeddedToastVisible] = useState(false);

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  const [localTitle, setLocalTitle] = useState(activeNote?.title ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [movePicker, setMovePicker] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [relatedNotes, setRelatedNotes] = useState<RelatedNote[]>([]);
  const [noteMemories, setNoteMemories] = useState<ApiMemory[]>([]);
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
  // Tracks which note id the editor was last hydrated from. We re-sync editor
  // content from the server only when this differs from the current activeNoteId
  // (a real note switch) — never on autosave round-trips, which previously could
  // race with live typing and wipe in-progress edits when the new content
  // happened to differ from the editor's local state (notably with base64
  // images, where server normalization or a silently-failed save left the
  // store holding empty content that then clobbered the editor).
  const hydratedNoteId = useRef<number | null>(null);
  // Editor handle exposed as a ref so effects declared *before* useEditor (the
  // save-on-leave + beforeunload flushes) can read editor.getHTML() at flush
  // time without hitting a temporal dead zone error. The ref is populated by a
  // sync effect right after useEditor returns.
  const editorRef = useRef<Editor | null>(null);
  // Embedded mode is ephemeral: no server note is created until the user submits.
  // Ref so handleKeyDown (captured once inside useEditor) always calls the latest handleSubmit.
  const handleSubmitRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    // Flush any unsaved changes (e.g. a dropped image, an in-flight image
    // replace) before leaving the previous note.
    //
    // Three weak points in the original gate were causing notes to silently
    // lose their last-edit-before-switch:
    //   1. `hasChanges.current` could be racily false — if an autosave just
    //      succeeded one tick before the switch, hasChanges flipped back to
    //      false and this whole branch was skipped.
    //   2. `bodyRef.current` could be stale — TipTap's setImage/setContent
    //      transactions commit synchronously but onUpdate (which writes
    //      bodyRef) fires after; if the user switched notes in the same JS
    //      task as an image insert, bodyRef hadn't caught up.
    //   3. `.catch(() => {})` swallowed all PATCH failures (oversize body,
    //      network blip, 4xx/5xx) — no console log, no UI signal.
    //
    // Fix: always read from the editor directly, drop the hasChanges gate,
    // and surface failures to the console at minimum. Cost is one extra PATCH
    // per note switch even when nothing changed — backend's empty-overwrite
    // guard makes that safe, and the updated_at bump is cheap.
    const prevId = prevActiveNoteId.current;
    if (prevId && prevId > 0 && prevId !== activeNoteId) {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      const currentBody = editorRef.current?.getHTML() ?? bodyRef.current;
      const currentTitle = titleRef.current;
      updateNote(prevId, currentTitle, currentBody).catch((err) => {
        console.error(`[NoteEditor] save-on-leave failed for note #${prevId}:`, err);
      });
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
    setNoteMemories([]);
    setDeleteConfirm(false);
    setLocalIsPublic(activeNote?.is_public ?? false);
    setSuggestedQuestions([]);
    hasChanges.current = false;
  }, [activeNoteId]);

  // Load related notes + memories tied to this note after it settles
  // (quiet, non-blocking). Both feed the post-editor footer block.
  useEffect(() => {
    if (!activeNoteId || activeNoteId < 0) return;
    const t = setTimeout(async () => {
      const [related, mems] = await Promise.all([
        fetchRelatedNotes(activeNoteId),
        fetchNoteMemories(activeNoteId),
      ]);
      setRelatedNotes(related.filter((n) => n.id !== activeNoteId).slice(0, 2));
      setNoteMemories(mems);
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

  // Flush pending save on tab close (keepalive: true in api.ts ensures the request survives).
  // Same hasChanges/bodyRef race as save-on-leave — read from editor directly and don't gate
  // on hasChanges. Worst case is one extra PATCH on tab close; backend's empty-overwrite
  // guard makes that safe.
  useEffect(() => {
    function onBeforeUnload() {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (activeNoteId && activeNoteId > 0) {
        const currentBody = editorRef.current?.getHTML() ?? bodyRef.current;
        apiUpdateNote(activeNoteId, titleRef.current, currentBody);
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
        NoteLink,
      ],
      content: activeNote?.content ?? "",
      autofocus: embedded ? "end" : false,
      editorProps: {
        attributes: {
          style: [
            "font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            embedded ? "font-size: 14.5px" : "font-size: 15.5px",
            "line-height: 1.65",
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

  // Mirror the editor handle into a ref so the early effects (save-on-leave,
  // beforeunload) can read editor.getHTML() at flush time. Sync assignment —
  // this runs every render before any effect, so the ref is current by the
  // time React fires the leave/unload callbacks.
  editorRef.current = editor;

  // Keep editorEmpty in sync when switching notes
  useEffect(() => {
    if (editor) setEditorEmpty(editor.isEmpty);
  }, [editor, activeNoteId]);

  // Toggle .is-empty on the editor DOM so the placeholder CSS tracks real emptiness
  // (not CSS :empty, which breaks the moment ProseMirror inserts a trailing <br>).
  // Guarded — when navigating between notes (e.g. brain-map → note), the editor
  // can briefly be present-but-destroyed; touching `view` then throws and the
  // ErrorBoundary surfaces a giant red banner. Skip if torn down.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    try {
      const el = editor.view.dom as HTMLElement;
      el.classList.toggle("is-empty", editorEmpty);
    } catch {
      // view not mounted yet — next effect run will catch up
    }
  }, [editor, editorEmpty]);

  // Click delegation for the NoteLink chip. ProseMirror swallows the default
  // anchor navigation, so we own the routing here: extract the noteId from the
  // chip's data-attr and route via Zustand's selectNote (which updates the
  // URL through the route's effect downstream).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement;
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const chip = target?.closest("a[data-note-link]") as HTMLAnchorElement | null;
      if (!chip) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(chip.getAttribute("data-note-id") || "");
      if (!id) return;
      // Persist any pending edits before yanking the active note out from
      // under us — same pattern handleSubmit uses on quick-note submit.
      void save();
      selectNote(id);
      navigate({ to: "/", search: { note: id, conv: undefined, list: undefined, audit: undefined } });
    };
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [editor, navigate, selectNote]);

  /**
   * BubbleMenu "↗ Extract" handler — carve the current selection out of the
   * parent note into a new child note and replace the selection with a
   * NoteLink chip. POSTing the selected HTML before mutating the parent
   * editor avoids a race where the user keeps typing during the network
   * round-trip and the autosave clobbers the chip insert.
   */
  async function handleExtractToChildNote() {
    if (!editor || editor.isDestroyed) return;
    if (!activeNoteId || activeNoteId <= 0) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const slice = editor.state.doc.slice(from, to);
    const fragment = DOMSerializer.fromSchema(editor.state.schema).serializeFragment(slice.content);
    const tmp = document.createElement("div");
    tmp.appendChild(fragment);
    const selectedHtml = tmp.innerHTML.trim();
    if (!selectedHtml) return;
    let child: ApiNote | null = null;
    try {
      child = await apiExtractToChildNote(activeNoteId, selectedHtml);
    } catch {
      return; // silent — selection stays intact
    }
    if (!child) return;
    const labelSource = (child.excerpt_anchor || child.title || tmp.textContent || "note").trim();
    const label = labelSource.length > 40 ? labelSource.slice(0, 40) + "…" : labelSource;
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({ type: "noteLink", attrs: { noteId: child.id, label } })
      .run();
    bodyRef.current = editor.getHTML();
    hasChanges.current = true;
    scheduleSave();
  }

  async function handleSubmit() {
    if (!editor || editor.isEmpty) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    // Capture the rect BEFORE any state mutation so the ink animation has the right origin.
    const buttonRect = submitButtonRef.current?.getBoundingClientRect() ?? null;
    const contentToSave = bodyRef.current;
    let savedNote: ApiNote | null = null;

    if (embedded && !activeNoteId) {
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

    // Fire embed → classify → signals pipeline on submit too. Without this
    // the dashboard quick-note + plan paths never trigger classification —
    // embed only ran via the editor's onBlur, which submit doesn't go through.
    if (savedNote?.id) {
      const submittedId = savedNote.id;
      embedAndCheck(submittedId);
      // Embedded composer surfaces a transient toast since the disclosure
      // block lives in the full-variant render path. Clear any prior toast
      // and start a poll for the classify_signals payload.
      if (embedded) {
        // Cancel any in-flight pill before starting a new one.
        setEmbeddedToastVisible(false);
        setEmbeddedToast(null);
        setTimeout(async () => {
          try {
            const fresh = await apiFetchNote(submittedId);
            const sig = fresh.classify_signals;
            if (sig && (sig.feature_requests?.length || sig.memory_count > 0)) {
              setEmbeddedToast({ noteId: submittedId, signals: sig });
              // Two ticks before flipping visible so the initial transform="translateY"
              // has applied — otherwise the slide-in is skipped and the pill
              // simply pops in. requestAnimationFrame x2 = "after browser has
              // committed the mount frame".
              requestAnimationFrame(() => {
                requestAnimationFrame(() => setEmbeddedToastVisible(true));
              });
              // Visible window: 6s. Then slide out (320ms transition), then unmount.
              setTimeout(() => {
                setEmbeddedToastVisible(false);
                setTimeout(() => {
                  setEmbeddedToast((curr) => (curr?.noteId === submittedId ? null : curr));
                }, 360);
              }, 6000);
            }
          } catch {
            // note may have been deleted — ignore
          }
        }, 3500);
      }
    }

    onSubmitted?.(savedNote, buttonRect);
  }

  // Keep handleSubmitRef current so the editor's once-captured handleKeyDown always calls fresh state.
  handleSubmitRef.current = handleSubmit;

  // Sync editor + local refs from activeNote.
  //
  // Body content: setContent ONLY when the editor hasn't been hydrated for the
  // current activeNoteId yet. That covers two real cases:
  //   (a) note switch — activeNoteId changed, load the new body
  //   (b) lazy load — note was selected before its space's notes finished loading;
  //       activeNote starts null then arrives, editor is still empty
  // Once hydrated, the editor is the source of truth until the user navigates
  // to another note. We do NOT re-sync from activeNote.content on autosave
  // round-trips — that's the bug class that wiped notes when starting with an
  // image (server-normalized or empty content clobbering live edits).
  //
  // Title + is_public stay reactive — they're controlled inputs without the
  // same race surface and benefit from updates after server-side normalization.
  useEffect(() => {
    if (!editor || !activeNote) return;
    if (hydratedNoteId.current !== activeNoteId) {
      const desired = activeNote.content ?? "";
      if (editor.getHTML() !== desired) {
        editor.commands.setContent(desired);
        bodyRef.current = desired;
      }
      hydratedNoteId.current = activeNoteId;
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
    } catch (err) {
      // Surface the failure instead of swallowing it. hasChanges stays true so
      // the next keystroke or scheduleSave() retries automatically — and the
      // editor's content is NOT discarded. Logging the error makes the
      // image-too-large / 409-empty-overwrite / network-blip cases debuggable.
      console.error(`[NoteEditor] save failed for note #${activeNoteId}:`, err);
      setSaveStatus("error");
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
    // classify_note runs in a daemon thread on the backend — by the time the
    // /embed POST returns, classification hasn't finished. Schedule a refetch
    // ~3s out so the editor picks up the new `classify_signals` payload and
    // renders the "Routed:" disclosure.
    setTimeout(() => { refetchNote(noteId).catch(() => {}); }, 3000);
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
              background: "var(--gooni-card, #FFFFFF)",
              border: "1px solid var(--gooni-border, rgba(0,0,0,0.07))",
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              position: "relative",
            }
          : {
              flex: 1,
              height: "100vh",
              background: "var(--gooni-card, #FFFFFF)",
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
          // Toolbar sits next to the "Updated …" text instead of being
          // banished to the far right — Daniel said the action icons feel
          // far away when they're the only thing on the right edge. Save
          // status + toolbar both anchor left with a small gap.
          gap: 12,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color:
              saveStatus === "saving" ? "#8E8E93"
              : saveStatus === "saved" ? "#34C759"
              : saveStatus === "error" ? "#FF3B30"
              : "#8E8E93",
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            transition: "color 0.2s",
          }}
        >
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "saved"
            ? `Saved ${lastSavedTime}`
            : saveStatus === "error"
            ? "Save failed — your changes are still in the editor. Retrying on next edit."
            : activeNote
            ? `Created ${formatShortDate(activeNote.created_at)} · Updated ${formatNoteDate(activeNote.updated_at)}`
            : ""}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Space suggestion */}
          {spaceSuggestion?.suggested_space_id && activeNote?.space_id === null && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 14, background: "rgba(0,122,255,0.08)", fontSize: 12, color: "#007AFF", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
              <SpaceIcon emoji={spaceSuggestion.suggested_space_emoji} size={13} color="#007AFF" />
              <span>{spaceSuggestion.suggested_space_name}?</span>
              <button
                onClick={() => { if (activeNoteId) moveNote(activeNoteId, currentSpaceId, String(spaceSuggestion.suggested_space_id)); setSpaceSuggestion(null); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#007AFF", fontWeight: 600, fontSize: 12, padding: 0 }}
              >Move</button>
              <button
                onClick={() => setSpaceSuggestion(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 13, padding: 0, lineHeight: 1 }}
              >×</button>
            </div>
          )}
          {/* Move to... button */}
          {activeNote && moveTargets.length > 0 && (
            <div ref={movePickerRef} style={{ position: "relative" }}>
              <Tooltip label="Move to space">
                <button
                  onClick={() => setMovePicker((p) => !p)}
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
                  <FolderInput size={15} strokeWidth={1.7} />
                </button>
              </Tooltip>
              {movePicker && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    right: 0,
                    background: "var(--gooni-card, #FFFFFF)",
                    borderRadius: 10,
                    boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
                    padding: 6,
                    minWidth: 160,
                    zIndex: 100,
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
                        color: "var(--gooni-text, #1C1C1E)",
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
              <Tooltip label="Delete note">
                <button
                  onClick={() => setDeleteConfirm((p) => !p)}
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
                  <Trash2 size={15} strokeWidth={1.7} />
                </button>
              </Tooltip>
              {deleteConfirm && (
                <div style={{
                  position: "absolute", top: "calc(100% + 6px)", right: 0,
                  background: "var(--gooni-card, #FFFFFF)", borderRadius: 10,
                  boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
                  padding: 6, minWidth: 160, zIndex: 100,
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
          <Tooltip label={activeNote.is_pinned ? "Unpin from sidebar" : "Pin to sidebar"}>
            <button
              onClick={handleTogglePin}
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
              <PinIcon
                size={15}
                strokeWidth={1.7}
                color={activeNote.is_pinned ? "#F59E0B" : "#636366"}
                fill={activeNote.is_pinned ? "#F59E0B" : "none"}
              />
            </button>
          </Tooltip>
        )}

        {/* Public toggle — same visual family as Pin: icon-only with colored background when active */}
        {activeNote && activeNoteId && activeNoteId > 0 && (
          <Tooltip label={localIsPublic ? "Unpublish from portfolio" : "Publish to portfolio"}>
            <button
              onClick={() => {
                if (!activeNoteId || activeNoteId < 0) return;
                const next = !localIsPublic;
                setLocalIsPublic(next);
                apiPatchNote(activeNoteId, { is_public: next }).catch(() => {});
              }}
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
          </Tooltip>
        )}

        </div>
      </div>
      )}

      {/* Editor content */}
      {embedded ? (
        <>
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
                      insertImageBlock(editor, reader.result);
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
                      insertImageBlock(editor, reader.result);
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
        {embeddedToast && (() => {
          const sig = embeddedToast.signals;
          const fr = sig.feature_requests || [];
          const memCount = sig.memory_count || 0;
          const parts: string[] = [];
          if (fr.length) parts.push(`backlog (${fr.length})`);
          if (memCount) parts.push(`memory (${memCount})`);
          const summary = parts.join(" · ");
          const openBacklog = async () => {
            try {
              const { useListsStore } = await import("../../stores/useListsStore");
              const lists = useListsStore.getState().lists;
              const backlog = lists.find((l) => l.type === "backlog");
              if (backlog) {
                navigate({ to: "/", search: { note: undefined, conv: undefined, list: backlog.id , audit: undefined} });
              }
            } catch (e) { console.error(e); }
          };
          const openNote = () => {
            navigate({ to: "/", search: { note: embeddedToast.noteId, conv: undefined, list: undefined , audit: undefined} });
          };
          return (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                // Slide up from below the composer + fade. Auto-dismiss after
                // 6s; no manual close affordance per the cleaner aesthetic.
                opacity: embeddedToastVisible ? 1 : 0,
                transform: embeddedToastVisible ? "translateY(0)" : "translateY(8px)",
                transition: "opacity 320ms ease, transform 320ms ease",
                pointerEvents: embeddedToastVisible ? "auto" : "none",
              }}
            >
              <button
                onClick={fr.length ? openBacklog : openNote}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7,
                  padding: "4px 11px", borderRadius: 999,
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: "var(--gooni-surface, rgba(0,0,0,0.03))",
                  color: "var(--gooni-text, #1C1C1E)",
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                  fontSize: 11.5, fontWeight: 500, letterSpacing: 0.1,
                  cursor: "pointer",
                  transition: "background 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,0,0,0.12)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--gooni-surface, rgba(0,0,0,0.03))";
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,0,0,0.08)";
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#16A34A" }} />
                <span style={{ color: "var(--gooni-muted, #8E8E93)" }}>Routed</span>
                <span>{summary}</span>
                {fr[0] ? <span style={{ color: "var(--gooni-muted, #8E8E93)" }}>· {fr[0].title}</span> : null}
                <span style={{ marginLeft: 2, color: "var(--gooni-muted, #8E8E93)" }}>↗</span>
              </button>
            </div>
          );
        })()}
        </>
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
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                }}
              >
                <div style={{ fontSize: 28, marginBottom: 12 }}>📝</div>
                <div style={{ fontSize: 15, color: "var(--gooni-muted, #8E8E93)", marginBottom: 4 }}>No note selected</div>
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
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                    color: "var(--gooni-text, #1C1C1E)",
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    marginBottom: 16,
                    padding: 0,
                    lineHeight: 1.3,
                  }}
                />
                {(() => {
                  const sig = activeNote.classify_signals;
                  if (!sig) return null;
                  const fr = sig.feature_requests || [];
                  const memCount = sig.memory_count || 0;
                  if (fr.length === 0 && memCount === 0) return null;

                  const parts: string[] = [];
                  if (fr.length) parts.push(`backlog (${fr.length})`);
                  if (memCount) parts.push(`memory (${memCount})`);
                  const summary = parts.join(" · ");

                  // Find the backlog list id for the deep-link. We import lazily
                  // via the store at click time; no need to subscribe here.
                  const openBacklog = async () => {
                    try {
                      const { useListsStore } = await import("../../stores/useListsStore");
                      const lists = useListsStore.getState().lists;
                      const backlog = lists.find((l) => l.type === "backlog");
                      if (backlog) {
                        navigate({ to: "/", search: { note: undefined, conv: undefined, list: backlog.id , audit: undefined} });
                      }
                    } catch (e) {
                      console.error("openBacklog failed", e);
                    }
                  };

                  return (
                    <div style={{ marginBottom: 14, maxWidth: 720 }}>
                      <button
                        onClick={() => setSignalsExpanded((v) => !v)}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          padding: "4px 10px", borderRadius: 999,
                          border: "1px solid rgba(22,163,74,0.30)",
                          background: "rgba(22,163,74,0.08)",
                          color: "#166534",
                          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                          fontSize: 11.5, fontWeight: 600, letterSpacing: 0.2,
                          cursor: "pointer",
                          transition: "background 0.12s",
                        }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(22,163,74,0.14)")}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(22,163,74,0.08)")}
                      >
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#16A34A" }} />
                        Routed: {summary}
                        <span style={{ fontSize: 9, marginLeft: 2 }}>{signalsExpanded ? "▾" : "▸"}</span>
                      </button>
                      {signalsExpanded && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: "8px 12px",
                            borderRadius: 8,
                            background: "rgba(0,0,0,0.03)",
                            border: "1px solid var(--gooni-border, rgba(0,0,0,0.07))",
                            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                            fontSize: 12.5,
                            color: "#3C3C43",
                            lineHeight: 1.5,
                            display: "inline-block",
                          }}
                        >
                          {fr.length > 0 && (
                            <div style={{ marginBottom: memCount ? 6 : 0 }}>
                              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "#9CA3AF", marginBottom: 2 }}>
                                Feature requests — Gooni Backlog
                              </div>
                              {fr.map((f) => (
                                <div key={f.list_item_id}>
                                  ·{" "}
                                  <button
                                    onClick={openBacklog}
                                    style={{
                                      background: "none", border: "none", padding: 0,
                                      color: "#0EA5E9", cursor: "pointer", fontSize: "inherit",
                                      fontFamily: "inherit",
                                    }}
                                  >
                                    {f.title} ↗
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {memCount > 0 && (
                            <div>
                              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "#9CA3AF", marginBottom: 2 }}>
                                Memories — reconciler
                              </div>
                              <div>
                                · {memCount} written
                                {sig.memory_types?.length ? ` (${sig.memory_types.join(", ")})` : ""}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
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
                    {/* Vertical separator before the structural action — keeps
                        the formatting marks visually grouped. */}
                    {activeNoteId && activeNoteId > 0 && (
                      <>
                        <span style={{ width: 1, height: 16, background: "rgba(255,255,255,0.18)", margin: "0 4px" }} />
                        <button
                          title="Extract to new linked note"
                          onMouseDown={(e) => { e.preventDefault(); void handleExtractToChildNote(); }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            gap: 4,
                            height: 26,
                            padding: "0 8px",
                            borderRadius: 5,
                            border: "none",
                            background: "transparent",
                            color: "rgba(255,255,255,0.78)",
                            cursor: "pointer",
                            fontSize: 11,
                            fontWeight: 500,
                            transition: "background 0.1s, color 0.1s",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.12)"; e.currentTarget.style.color = "#fff"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.78)"; }}
                        >
                          <CornerUpRight size={13} strokeWidth={1.9} />
                          Extract
                        </button>
                      </>
                    )}
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
                          insertImageBlock(editor, reader.result);
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
                          insertImageBlock(editor, reader.result);
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

                {noteMemories.length > 0 && (
                  <div style={{ marginTop: 48, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>MEMORIES FROM THIS NOTE</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {noteMemories.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => navigate({ to: "/memories" })}
                          title={m.content}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 6,
                            padding: "4px 10px", borderRadius: 999,
                            border: `0.5px solid ${memoryTint(m.type).border}`,
                            background: memoryTint(m.type).bg,
                            color: memoryTint(m.type).fg,
                            fontSize: 11.5, fontWeight: 500,
                            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                            cursor: "pointer", maxWidth: 260,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}
                        >
                          <span style={{ fontSize: 9.5, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.4 }}>{m.type}</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.content.length > 60 ? m.content.slice(0, 60) + "…" : m.content}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {relatedNotes.length > 0 && (
                  <div style={{ marginTop: noteMemories.length > 0 ? 28 : 48, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>RELATED</p>
                    {relatedNotes.map((n) => {
                      const targetSpaceId = n.space_id ? String(n.space_id) : "general";
                      const sim = Math.max(0, Math.min(1, n.similarity ?? 0));
                      return (
                        <button
                          key={n.id}
                          onClick={async () => { selectSpace(targetSpaceId); await loadNotes(targetSpaceId); selectNote(n.id); }}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "7px 0", background: "none", border: "none", cursor: "pointer", gap: 12, borderRadius: 6 }}
                          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)")}
                          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "none")}
                        >
                          <span style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            minWidth: 30, height: 18, borderRadius: 9, padding: "0 6px",
                            background: similarityTint(sim).bg, color: similarityTint(sim).fg,
                            fontSize: 10.5, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                            flexShrink: 0,
                          }}>
                            {Math.round(sim * 100)}
                          </span>
                          <span style={{ fontSize: 14, color: "var(--gooni-text, #1C1C1E)", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                            {displayTitle(n)}
                          </span>
                          <span style={{ fontSize: 12, color: "#AEAEB2", flexShrink: 0, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                            {formatNoteDate(n.updated_at)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {suggestedQuestions.length > 0 && (
                  <div style={{ marginTop: relatedNotes.length > 0 ? 28 : 48, paddingTop: 20, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                      QUESTIONS GOONI WOULD ASK
                    </p>
                    {suggestedQuestions.map((q, i) => (
                      <button
                        key={i}
                        onClick={() => askGooni(q)}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", marginBottom: 6, background: "rgba(0,0,0,0.025)", border: "1px solid rgba(0,0,0,0.05)", borderRadius: 8, cursor: "pointer", fontSize: 13.5, color: "var(--gooni-text, #1C1C1E)", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", lineHeight: 1.5 }}
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
