import { Figure } from "./FigureExtension";
import { Attachment } from "./AttachmentExtension";
import { LinkCard } from "./LinkCardExtension";
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
  Heading1, Heading2,
  Trash2, FolderInput, Pin as PinIcon, ListPlus, Check, Pencil as PencilIcon,
  StickyNote, CheckCircle2, Droplet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { SlashCommand } from "./slash-command";
import { NoteLink } from "./NoteLinkExtension";
import { PublishButton } from "./PublishButton";
import { ToggleBlock } from "./ToggleBlockExtension";
import { OutlinePanel } from "./OutlinePanel";
import { NoteCard } from "./NoteCardExtension";
import { NoteMention } from "./note-mention";
import { TextColor, TEXT_COLOR_PALETTE } from "./TextColorExtension";
import { useNoteCardStyles } from "./noteCardStyles";
import { SendButton } from "../chat/SendButton";
import { createNote as apiCreateNote, updateNote as apiUpdateNote, memorizeNote as apiMemorizeNote, touchNote as apiTouchNote, embedNote as apiEmbedNote, fetchNote as apiFetchNote, fetchNoteMemories, patchNote as apiPatchNote, extractToChildNote as apiExtractToChildNote, autoTitleNote as apiAutoTitleNote, uploadImage as apiUploadImage, uploadAttachment as apiUploadAttachment, fetchOgMetadata, saveLocalNoteDraft, readLocalNoteDraft, clearLocalNoteDraft, type ApiNote, type ApiMemory, type NoteClassifySignals, type SpaceSuggestion } from "../../services/api";
import { NoteMemoriesPanel } from "./NoteMemoriesPanel";
import { NoteComments } from "./NoteComments";
import { ReactionBar } from "../ReactionBar";
import { DOMSerializer } from "@tiptap/pm/model";
import { CornerUpRight } from "lucide-react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useDraftVersionStore } from "../../stores/useDraftVersionStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { Tooltip } from "../Tooltip";
import { SpaceIcon } from "./SpaceIcon";

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
      // Figure node owns the new image flow — inherits resize / align /
      // caption controls. Default attrs (align=center, width=100, no
      // caption) match what the user sees pre-tweak.
      { type: "figure", attrs: { src, alt: null, width: 100, align: "center", caption: "" } },
      { type: "paragraph" },
    ])
    .run();
}

// Push a pasted/dropped image up to R2 and insert the resulting URL into
// the editor. Falls back to the legacy base64 data: URL path when the
// backend reports R2 isn't configured (dev / un-provisioned envs) or any
// other error — losing an upload is worse UX than carrying a heavy image.
//
// `notify` lets callers surface errors; passing `undefined` swallows them.
async function uploadAndInsertImage(
  editor: Editor,
  file: File,
  notify?: (msg: string) => void,
): Promise<void> {
  let result;
  try {
    result = await apiUploadImage(file);
  } catch (e) {
    console.error("[NoteEditor] image upload network error:", e);
    result = { kind: "error" as const, status: 0, message: "network error" };
  }

  if (result.kind === "url") {
    insertImageBlock(editor, result.url);
    return;
  }

  if (result.kind === "error") {
    console.warn(
      `[NoteEditor] image upload failed (${result.status}): ${result.message} — falling back to inline base64`,
    );
    notify?.(`Image upload failed (${result.status || "network"}): inlined as base64 instead`);
  }

  // Fallback path — read the file as a data URL and insert inline. This
  // matches the pre-R2 behavior so any environment without R2 wired up
  // still works end-to-end.
  await new Promise<void>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        insertImageBlock(editor, reader.result);
      }
      resolve();
    };
    reader.onerror = () => resolve();
    reader.readAsDataURL(file);
  });
}

// Upload a non-image file to R2 and insert an AttachmentNode pointing at
// it. No base64 fallback — opaque files don't render inline. We bail and
// surface the error instead of dirtying the note with a broken URL.
// Tight regex: clipboard text counts as a URL paste ONLY when it's
// http(s)://something with no whitespace. Anything trailing (extra text,
// commentary, multiple URLs) falls through to TipTap's normal paste.
const URL_PASTE_RE = /^https?:\/\/[^\s]+$/i;

/**
 * If `text` is a bare URL, replace it with a LinkCard node at cursor and
 * fetch OG metadata async. Returns true if handled. Caller must already
 * have called e.preventDefault() synchronously — this helper is async.
 */
async function pasteAsLinkCardIfUrl(editor: Editor, text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!URL_PASTE_RE.test(trimmed)) return false;
  const hostname = (() => {
    try { return new URL(trimmed).hostname.replace(/^www\./, ""); }
    catch { return trimmed; }
  })();
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: "linkCard",
        attrs: {
          url: trimmed,
          title: trimmed,
          description: null,
          image: null,
          siteName: hostname,
        },
      },
      { type: "paragraph" },
    ])
    .run();
  // OG fetch + patch attrs in the background. If the user keeps typing,
  // node positions can drift — walk the doc to find the most-recent
  // linkCard with this URL and update by its current pos.
  void (async () => {
    try {
      const og = await fetchOgMetadata(trimmed);
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "linkCard" && node.attrs.url === trimmed) {
          targetPos = pos; // last match wins → most-recently inserted card
        }
        return true;
      });
      if (targetPos == null) return;
      editor.commands.command(({ tr }) => {
        tr.setNodeAttribute(targetPos!, "title", og.title || trimmed);
        if (og.description) tr.setNodeAttribute(targetPos!, "description", og.description);
        if (og.image) tr.setNodeAttribute(targetPos!, "image", og.image);
        if (og.site_name) tr.setNodeAttribute(targetPos!, "siteName", og.site_name);
        return true;
      });
    } catch (e) {
      // OG fetch failed — leave the placeholder card (it still has url +
      // hostname). User can delete or keep.
      console.warn("[NoteEditor] OG fetch failed for", trimmed, e);
    }
  })();
  return true;
}

async function uploadAndInsertAttachment(
  editor: Editor,
  file: File,
  noteId: number | undefined,
  notify?: (msg: string) => void,
): Promise<void> {
  let result;
  try {
    result = await apiUploadAttachment(file, noteId);
  } catch (e) {
    console.error("[NoteEditor] file upload network error:", e);
    notify?.("Attachment upload failed (network)");
    return;
  }
  if (result.kind !== "url") {
    const reason = result.kind === "fallback" ? result.reason : `${result.status}: ${result.message}`;
    console.warn(`[NoteEditor] attachment upload failed: ${reason}`);
    notify?.(`Attachment upload failed (${reason})`);
    return;
  }
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: "attachment",
        attrs: {
          url: result.url,
          filename: result.filename,
          mime: result.mime_type,
          size: result.size_bytes,
          attachmentId: result.attachment_id,
        },
      },
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
      .gooni-note-editor {
        outline: none;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        font-size: 14.5px;
        line-height: 1.55;
        color: #1C1C1E;
        -webkit-font-smoothing: antialiased;
      }
      .gooni-note-editor p { margin: 0 0 10px; }
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
      @keyframes gooni-spin { to { transform: rotate(360deg); } }
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
      /* Extracted-to-child note chip — inline-flow link styling (no pill
         chrome). Stays in the text line so the parent reads as normal
         prose with a single colored hyperlink, not "look here's a UI
         widget". Same color family as the public-prose anchor. */
      .gooni-note-editor a.gooni-note-link {
        color: #2563EB;
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 2px;
        cursor: pointer;
        font-size: inherit;
        font-weight: inherit;
      }
      .gooni-note-editor a.gooni-note-link:hover {
        color: #1D4ED8;
      }
      .gooni-note-editor a.gooni-note-link.ProseMirror-selectednode {
        background: rgba(37,99,235,0.10);
        border-radius: 2px;
      }
      .gooni-note-editor img.ProseMirror-selectednode {
        outline: 2px solid #007AFF;
      }
      /* Figure (Image + caption + alignment + width). Floats clear so a
         non-figure block following a row of side-by-side figures lands
         on its own line — same shape as the public read page. */
      .gooni-note-editor .gooni-figure { box-sizing: border-box; padding: 0; }
      .gooni-note-editor .gooni-figure + p::after,
      .gooni-note-editor .gooni-figure + h1::after,
      .gooni-note-editor .gooni-figure + h2::after,
      .gooni-note-editor .gooni-figure + h3::after { content: ""; display: block; clear: both; }
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
      /* NoteCard + TextColor CSS lives in ./noteCardStyles.ts so the public
         read view can mount the same rules (visual parity). See
         useNoteCardStyles() call in this component. */
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

// Notion-style "Edited Xm ago" label — relative under 30 min, then snaps
// to absolute clock time ("Edited at 11:00 PM" today, or "Edited <date>"
// for older). Used on the floating top-right activity chip.
function formatEdited(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const diffMs = nowMs - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "Edited just now";
  if (min < 30) return `Edited ${min}m ago`;
  const now = new Date(nowMs);
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return "Edited at " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  return "Edited " + d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function relativeFromNow(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const diffMs = nowMs - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Right-island activity chip — shows live "Edited Xm ago" with a hover
// popover that lists Edited + Created timestamps. Mirrors Notion's
// top-right Activity card.
function EditedChip({
  updatedAt,
  createdAt,
}: {
  updatedAt: string | null;
  createdAt: string | null;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [hover, setHover] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const label = formatEdited(updatedAt, nowMs);
  if (!label) return null;

  return (
    <div
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          display: "inline-flex", alignItems: "center",
          height: 26, padding: "0 10px",
          borderRadius: 8,
          fontSize: 12, fontWeight: 500,
          color: "#6E6E73",
          background: "rgba(255,255,255,0.82)",
          backdropFilter: "blur(22px) saturate(1.8)",
          WebkitBackdropFilter: "blur(22px) saturate(1.8)",
          boxShadow: "0 1px 2px rgba(15,23,42,0.05), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          cursor: "default",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      {hover && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 240,
            background: "#fff",
            borderRadius: 10,
            padding: "10px 12px",
            boxShadow:
              "0 12px 28px rgba(15,23,42,0.16), 0 2px 6px rgba(15,23,42,0.10), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            zIndex: 30,
          }}
        >
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
            textTransform: "uppercase", color: "#8E8E93", marginBottom: 6,
          }}>Activity</div>
          <div style={{
            display: "flex", justifyContent: "space-between", gap: 16,
            fontSize: 12.5, color: "#1C1C1E", padding: "3px 0",
          }}>
            <span>Edited</span>
            <span style={{ color: "#6E6E73" }} title={formatAbsolute(updatedAt)}>
              {relativeFromNow(updatedAt, nowMs)}
            </span>
          </div>
          <div style={{
            display: "flex", justifyContent: "space-between", gap: 16,
            fontSize: 12.5, color: "#1C1C1E", padding: "3px 0",
          }}>
            <span>Created</span>
            <span style={{ color: "#6E6E73" }}>{formatAbsolute(createdAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface NoteEditorProps {
  variant?: Variant;
  onSubmitted?: (note: ApiNote | null, buttonRect: DOMRect | null) => void;
  // Fires when the editor's empty state changes — lets parents react to
  // "user started typing" without reading editor internals.
  onEmptyChange?: (empty: boolean) => void;
  // Fires when the editor gains/loses focus. Used by the dashboard's
  // embedded composer to dim surrounding chrome (TakeTabs etc) so the
  // writing surface gets the eye.
  onFocusChange?: (focused: boolean) => void;
}

export function NoteEditor({ variant = "full", onSubmitted, onEmptyChange, onFocusChange }: NoteEditorProps = {}) {
  useEditorStyles();
  useNoteCardStyles();
  const embedded = variant === "embedded";

  const { selectedSpaceId, notes, activeNoteId, updateNote, refetchNote, moveNote, selectNote, deleteNote } = useNotesContentStore();
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
  // Embedded composer focus state — drives the expand-on-focus layout
  // (taller editor surface + parent dim of TakeTabs / focuses row).
  const [embeddedFocused, setEmbeddedFocused] = useState(false);

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  const [localTitle, setLocalTitle] = useState(activeNote?.title ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [movePicker, setMovePicker] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [noteMemories, setNoteMemories] = useState<ApiMemory[]>([]);
  const [spaceSuggestion, setSpaceSuggestion] = useState<SpaceSuggestion | null>(null);
  const [localIsPublic, setLocalIsPublic] = useState<boolean>(activeNote?.is_public ?? false);
  // Brief "tagged" pulse on the backlog button so the user sees confirmation
  // without a full toast. Resets after ~1.6s. Keyed by note id so switching
  // notes doesn't carry the green-checked state across.
  const [taggedNoteId, setTaggedNoteId] = useState<number | null>(null);
  const [taggingInFlight, setTaggingInFlight] = useState(false);
  // Local working copy of the note's tag set — patched through to the
  // backend on each add/remove. Decoupled from activeNote.tags so we can
  // show optimistic updates without waiting for the server round-trip.
  const [localTags, setLocalTags] = useState<string[]>(activeNote?.tags ?? []);
  const [newTagDraft, setNewTagDraft] = useState("");
  const [tagInputOpen, setTagInputOpen] = useState(false);
  // Guard against extract-spam — Daniel clicked Extract 6× during a
  // network stall and got 4 dupe children (PR #244 postmortem). Backend
  // also dedups within 30s, but the UI lock prevents the cascade of
  // dependent fetches (notes / pinned / drafts / children) that the
  // duplicate clicks triggered.
  const [extractInFlight, setExtractInFlight] = useState(false);
  // Parent note title cache — populated when the active note has a
  // parent_note_id so the back-pill can render the actual title instead
  // of "↑ from #42". Keyed by parent id so switching notes doesn't show
  // stale title flicker. `null` when no parent or fetch is in flight.
  const [parentLink, setParentLink] = useState<{ id: number; title: string } | null>(null);
  const movePickerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<string>(activeNote?.content ?? "");
  const titleRef = useRef<string>(activeNote?.title ?? "");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Note ids we've already attempted auto-title for in this session. Prevents
  // re-firing on every save; the user can rename and we won't overwrite.
  const autoTitledRef = useRef<Set<number>>(new Set());
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
    // Save-on-leave is gated on real edits since the gateless version was
    // bumping updated_at on every open via TipTap's serializer-roundtrip
    // (PR fix-note-open-delete): the editor re-emits HTML in a slightly
    // different shape than what the server stored (attribute order, self-
    // closing tags), so an unconditional PATCH made the server detect a
    // content change and bump updated_at — which then made notes jump to
    // the top of "Today" the moment they were opened. The trade is a
    // narrow image-insert race (setImage commits synchronously but
    // onUpdate fires next tick) — covered by the editor's onBlur save
    // and the localStorage stash fallback below.
    const prevId = prevActiveNoteId.current;
    if (prevId && prevId > 0 && prevId !== activeNoteId && hasChanges.current) {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      const currentBody = editorRef.current?.getHTML() ?? bodyRef.current;
      const currentTitle = titleRef.current;
      updateNote(prevId, currentTitle, currentBody).catch((err) => {
        console.error(`[NoteEditor] save-on-leave failed for note #${prevId}:`, err);
        try {
          saveLocalNoteDraft(prevId, currentTitle, currentBody);
        } catch {
          // best-effort; no UI signal needed for the fallback's fallback
        }
      });
    }

    setLocalTitle(activeNote?.title ?? "");
    bodyRef.current = activeNote?.content ?? "";
    titleRef.current = activeNote?.title ?? "";
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaveStatus("idle");
    setSpaceSuggestion(null);
    setNoteMemories([]);
    setDeleteConfirm(false);
    setLocalIsPublic(activeNote?.is_public ?? false);
    setLocalTags(activeNote?.tags ?? []);
    setNewTagDraft("");
    setTagInputOpen(false);
    hasChanges.current = false;
  }, [activeNoteId]);

  // Load memories tied to this note after it settles (quiet,
  // non-blocking). Feeds the post-editor memory pill row.
  useEffect(() => {
    if (!activeNoteId || activeNoteId < 0) return;
    const t = setTimeout(async () => {
      const mems = await fetchNoteMemories(activeNoteId);
      setNoteMemories(mems);
    }, 1000);
    return () => clearTimeout(t);
  }, [activeNoteId]);

  // Fetch the parent note's title when this note was extracted from one,
  // so the "↑ from <parent>" pill above the title shows the real title
  // (not "↑ from #42"). Cleared when navigating to a non-extracted note.
  useEffect(() => {
    const parentId = activeNote?.parent_note_id ?? null;
    if (!parentId) {
      setParentLink(null);
      return;
    }
    if (parentLink?.id === parentId) return; // already cached
    let cancelled = false;
    apiFetchNote(parentId)
      .then((p) => {
        if (cancelled) return;
        const t = (p.title ?? "").trim() || "Untitled";
        setParentLink({ id: parentId, title: t });
      })
      .catch(() => { if (!cancelled) setParentLink({ id: parentId, title: "note" }); });
    return () => { cancelled = true; };
  }, [activeNote?.parent_note_id, parentLink?.id]);

  // Refresh the active note when it becomes public so unique_viewers is
  // populated. The list-fetch path (fetchSpaceNotes) intentionally omits the
  // count to avoid N per-note Visit queries on every load — only the single
  // note GET carries it. Without this, the editor's viewer pill stays empty
  // until the next manual refetch.
  useEffect(() => {
    if (!activeNoteId || activeNoteId < 0) return;
    if (!activeNote?.is_public) return;
    if (typeof activeNote.unique_viewers === "number") return; // already hydrated
    refetchNote(activeNoteId).catch(() => {});
  }, [activeNoteId, activeNote?.is_public, activeNote?.unique_viewers, refetchNote]);

  // Lazy-fetch full body when opening a list-shape row. Space-list / recent /
  // pinned / drafts endpoints ship `content: null` (only excerpt + thumb_src)
  // to keep the column-2 payload small. Without this, the editor mounts empty
  // on first open and stays empty until some other path (autosave, memorize)
  // repopulates content in the store.
  useEffect(() => {
    if (!activeNoteId || activeNoteId < 0) return;
    if (!activeNote) return;
    if (activeNote.content != null) return; // already have full body
    refetchNote(activeNoteId).catch(() => {});
  }, [activeNoteId, activeNote?.content, refetchNote]);

  // Memorize previous note on leave; touch new note on enter — catches ALL
  // navigation paths. Embed + memorize are gated on isDirty so a pure open
  // (click → look → close) doesn't burn an OpenAI call or bump updated_at.
  // Touch is unconditional because last_opened_at is the whole point of the
  // open event and doesn't affect list ordering.
  useEffect(() => {
    const prev = prevActiveNoteId.current;
    prevActiveNoteId.current = activeNoteId;
    if (prev === activeNoteId) return; // initial mount, no change

    if (prev && prev > 0) {
      const wasDirty = useNotesContentStore.getState().isDirty;
      if (wasDirty) {
        embedAndCheck(prev);
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
        // Limit heading levels to 1 + 2 — note bodies don't need a 6-level
        // outline depth and the bubble-menu surface only exposes these two.
        StarterKit.configure({ heading: { levels: [1, 2] } }),
        Figure,
        Attachment,
        LinkCard,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        SlashCommand,
        NoteLink,
        NoteMention,
        NoteCard,
        TextColor,
        ToggleBlock,
      ],
      content: activeNote?.content ?? "",
      // Embedded variant intentionally does NOT autofocus — focus
       // triggers the dashboard's expand-and-dim layout, which would
       // fire on every dashboard mount otherwise. User clicks to start.
      autofocus: false,
      editorProps: {
        attributes: {
          // Font / size / line-height live in the .gooni-note-editor CSS
          // class (see useEditorStyles). Inline styles previously here
          // overrode that CSS and were the reason the full-variant body
          // still rendered at 16.5px / Inter after the Apple-Notes pass.
          style: [
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
          // Esc on the embedded composer collapses focus mode without
          // submitting. TipTap doesn't blur on Esc by default; do it here.
          if (embedded && event.key === "Escape") {
            event.preventDefault();
            (event.target as HTMLElement | null)?.blur?.();
            return true;
          }
          // Cmd/Ctrl+Shift+M → toggle inline code on selection. TipTap's
          // built-in Code shortcut is Mod-e; this adds the Apple-Notes-style
          // alias Daniel asked for.
          if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "m" || event.key === "M")) {
            event.preventDefault();
            editorRef.current?.chain().focus().toggleCode().run();
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
      onFocus: () => {
        if (embedded) {
          setEmbeddedFocused(true);
          onFocusChange?.(true);
        }
      },
      onBlur: async () => {
        if (embedded) {
          setEmbeddedFocused(false);
          onFocusChange?.(false);
          return;
        }
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
      // under us — same pattern handleExtractToChildNote uses (line 672).
      // The prior `void save()` was fire-and-forget: if the user typed
      // something into this note and then clicked a chip, the navigate
      // raced the PATCH and the error pill (if save failed) would land
      // on the destination note's editor instead of this one.
      void (async () => {
        try {
          await save();
        } catch {
          // save() doesn't throw — it sets saveStatus("error") and
          // localStorage-stashes the body. Catch defensively in case
          // that ever changes.
        }
        selectNote(id);
        navigate({ to: "/", search: { note: id, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: undefined } });
      })();
    };
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [editor, navigate, selectNote]);

  // NoteCard interactions: (1) click the hover check pill toggles checked,
  // (2) cmd/ctrl+click anywhere on the card body also toggles (keyboard
  // shortcut for power users). Both paths resolve a DOM click to a
  // ProseMirror doc pos via view.posAtDOM, then call the mark command.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const checkBtn = target.closest("[data-card-check]") as HTMLElement | null;
      const isCmdClick = (e.metaKey || e.ctrlKey) && !!target.closest("[data-note-card]");
      if (!checkBtn && !isCmdClick) return;
      const card = (checkBtn ?? target).closest("[data-note-card]") as HTMLElement | null;
      if (!card) return;
      // Aim the pos lookup at the content span — its first text child is
      // always inside the mark range. Falling back to the card wrapper
      // if the content span is missing for some reason.
      const content = card.querySelector(".gooni-note-card-content") as HTMLElement | null;
      const probe: Node = content?.firstChild ?? content ?? card;
      const pos = editor.view.posAtDOM(probe, 0);
      if (pos == null || pos < 0) return;
      e.preventDefault();
      e.stopPropagation();
      editor.commands.toggleNoteCardCheckedAtPos(pos);
    };
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [editor]);

  /**
   * BubbleMenu "↗ Extract" handler — carve the current selection out of the
   * parent note into a new child note and replace the selection with a
   * NoteLink chip. POSTing the selected HTML before mutating the parent
   * editor avoids a race where the user keeps typing during the network
   * round-trip and the autosave clobbers the chip insert.
   *
   * After the chip is in, we save the parent synchronously and jump the
   * editor to the new child — Daniel's mental model is "extract = pop a
   * draft out into its own note and continue writing there." Leaving the
   * user on the parent with just a chip felt like it half-shipped.
   */
  async function handleExtractToChildNote() {
    if (!editor || editor.isDestroyed) return;
    if (!activeNoteId || activeNoteId <= 0) return;
    if (extractInFlight) return; // ignore re-clicks while the network call is pending
    const parentId = activeNoteId;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const slice = editor.state.doc.slice(from, to);
    const fragment = DOMSerializer.fromSchema(editor.state.schema).serializeFragment(slice.content);
    const tmp = document.createElement("div");
    tmp.appendChild(fragment);
    const selectedHtml = tmp.innerHTML.trim();
    if (!selectedHtml) return;
    setExtractInFlight(true);
    let child: ApiNote | null = null;
    try {
      child = await apiExtractToChildNote(parentId, selectedHtml);
    } catch {
      setExtractInFlight(false);
      return; // silent — selection stays intact
    }
    if (!child) {
      setExtractInFlight(false);
      return;
    }
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
    // Persist parent's chip insertion BEFORE swapping notes — otherwise the
    // pending debounced save fires after activeNoteId flips and writes the
    // parent's content to the wrong row. await save() here is the only way
    // to guarantee the chip lands on the parent row.
    await save();
    // Make sure the freshly-created child is in the store before selectNote
    // reaches for it (otherwise the editor briefly renders an empty note).
    await refetchNote(child.id).catch(() => {});
    selectNote(child.id);
    navigate({ to: "/", search: { note: child.id, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: undefined } });
    setExtractInFlight(false);
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
      // List-shape rows ship `content: null`. Clear the editor so the
      // previous note's body doesn't bleed through, but DON'T mark hydrated
      // yet — the lazy refetch effect above will repopulate the full body
      // shortly, and we want the next pass to install it.
      if (activeNote.content == null && activeNoteId && activeNoteId > 0) {
        if (!editor.isEmpty) {
          // emitUpdate=false so the programmatic clear doesn't trip the
          // editor's onUpdate handler (which flips hasChanges + schedules
          // an autosave). Without this, opening a list-shape note marks
          // the doc dirty even though the user never typed.
          editor.commands.setContent("", { emitUpdate: false });
          bodyRef.current = "";
        }
        return;
      }
      // Check for a leftover unsaved draft in localStorage from a prior
      // failed save (e.g. fly OOM mid-PATCH on the previous session). If
      // it's newer than the server copy, prefer the local draft — the
      // server copy is by definition stale relative to the unsaved edits.
      // Falls back to server content when no draft exists or the server
      // copy is fresher.
      const serverContent = activeNote.content ?? "";
      const serverUpdatedMs = activeNote.updated_at
        ? new Date(activeNote.updated_at).getTime()
        : 0;
      const local = activeNoteId && activeNoteId > 0
        ? readLocalNoteDraft(activeNoteId)
        : null;
      let desired = serverContent;
      let desiredTitle = activeNote.title ?? "";
      let restoredFromLocal = false;
      if (local && local.savedAt > serverUpdatedMs) {
        desired = local.content;
        desiredTitle = local.title;
        restoredFromLocal = true;
      }
      if (editor.getHTML() !== desired) {
        // emitUpdate=false so loading a note doesn't trip onUpdate (which
        // would flip hasChanges + schedule an autosave). The save-on-leave
        // guard relied on hasChanges to skip clean opens, but onUpdate fired
        // on every programmatic load — so every note touch turned into an
        // /embed + /memorize cascade on the next switch. Pass false here +
        // the explicit `hasChanges.current = true` below covers the genuine
        // restore-from-local-draft case.
        editor.commands.setContent(desired, { emitUpdate: false });
        bodyRef.current = desired;
        // Re-sync editorEmpty since emitUpdate=false skips onUpdate.
        // Without this, MCP/auto-generated notes open with editorEmpty
        // stuck at its previous `true` value — the `.is-empty` class
        // stays on the editor DOM and the `::before` placeholder
        // renders ON TOP of the real content (Daniel's screenshot
        // 2026-05-18).
        setEditorEmpty(editor.isEmpty);
      }
      titleRef.current = desiredTitle;
      hydratedNoteId.current = activeNoteId;
      if (restoredFromLocal && activeNoteId && activeNoteId > 0) {
        // Mark dirty so the next debounce tick re-PATCHes the recovered
        // content to the server. On success, save() clears the stash.
        hasChanges.current = true;
        scheduleSave();
        console.info(
          `[NoteEditor] restored unsaved draft for note #${activeNoteId} from localStorage`,
        );
      }
    }
    const title = activeNote.title ?? "";
    if (titleRef.current !== title && hydratedNoteId.current !== activeNoteId) {
      setLocalTitle(title);
      titleRef.current = title;
    } else if (hydratedNoteId.current === activeNoteId && titleRef.current && localTitle !== titleRef.current) {
      setLocalTitle(titleRef.current);
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
      // Server has the canonical copy now — drop any stash that was waiting
      // for retry. Done eagerly so a stale stash from a prior outage doesn't
      // resurrect outdated content on next mount.
      try { clearLocalNoteDraft(activeNoteId); } catch {}
      setSaveStatus("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveStatus("idle"), 3000);
      maybeAutoTitle();
    } catch (err) {
      // Surface the failure instead of swallowing it. hasChanges stays true so
      // the next keystroke or scheduleSave() retries automatically — and the
      // editor's content is NOT discarded. Logging the error makes the
      // image-too-large / 409-empty-overwrite / network-blip cases debuggable.
      console.error(`[NoteEditor] save failed for note #${activeNoteId}:`, err);
      setSaveStatus("error");
      // Belt-and-braces: also stash the in-progress content. The retry-on-
      // next-keystroke path normally covers this, but if the user closes
      // the tab between failed save and next keystroke, the localStorage
      // copy is the only path back to their edits.
      try {
        saveLocalNoteDraft(activeNoteId, titleRef.current, bodyRef.current);
      } catch {}
    }
  }

  function maybeAutoTitle() {
    const noteId = activeNoteId;
    if (!noteId || noteId < 0) return;
    if (autoTitledRef.current.has(noteId)) return;
    const current = (titleRef.current || "").trim().toLowerCase();
    // Only auto-title placeholder titles. Any user-typed title wins.
    if (current && current !== "untitled" && current !== "new note") return;
    // Strip HTML quickly to gate on plaintext length. Below ~60 chars there's
    // not enough signal — let the note grow first.
    const plaintext = (bodyRef.current || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (plaintext.length < 60) return;
    autoTitledRef.current.add(noteId);
    apiAutoTitleNote(noteId).then((res) => {
      if (!res.generated || !res.title) return;
      // Only apply if user hasn't started typing a real title in the meantime.
      const stillPlaceholder = !titleRef.current.trim() ||
        titleRef.current.trim().toLowerCase() === "untitled" ||
        titleRef.current.trim().toLowerCase() === "new note";
      if (!stillPlaceholder) return;
      setLocalTitle(res.title);
      titleRef.current = res.title;
      // Sync the store so sidebar/list views pick up the new title without a refetch.
      refetchNote(noteId).catch(() => {});
    }).catch(() => {
      // Network / LLM hiccup — let the next save retry by clearing the guard.
      autoTitledRef.current.delete(noteId);
    });
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

  // Commit the local tag set to the server. Same optimistic pattern as
  // pin/draft toggles — patch the cached note in every space list so the
  // chips row stays in sync without a refetch.
  async function commitTags(next: string[]) {
    if (!activeNoteId || activeNoteId < 0) return;
    setLocalTags(next);
    try {
      const updated = await apiPatchNote(activeNoteId, { tags: next });
      // Server normalizes (lowercase / dedup / cap-60). Adopt its shape so
      // a user typing "FROM-Claude" doesn't keep that casing client-side.
      setLocalTags(updated.tags ?? next);
      useNotesContentStore.setState((s) => {
        const updatedNotes: Record<string, ApiNote[]> = {};
        for (const [k, list] of Object.entries(s.notes)) {
          updatedNotes[k] = list.map((n) =>
            n.id === activeNoteId ? { ...n, tags: updated.tags ?? next } : n,
          );
        }
        return { notes: updatedNotes };
      });
    } catch (e) {
      console.error("commitTags failed", e);
    }
  }

  function addTagFromDraft() {
    const raw = newTagDraft.trim();
    if (!raw) {
      setTagInputOpen(false);
      return;
    }
    const cleaned = raw.toLowerCase().slice(0, 60);
    if (localTags.includes(cleaned)) {
      setNewTagDraft("");
      return;
    }
    const next = [...localTags, cleaned];
    void commitTags(next);
    setNewTagDraft("");
  }

  function removeTag(tag: string) {
    const next = localTags.filter((t) => t !== tag);
    void commitTags(next);
  }

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

  async function handleToggleDraft() {
    if (!activeNote || !activeNoteId || activeNoteId < 0) return;
    const newDraft = !activeNote.is_draft;
    try {
      await apiPatchNote(activeNoteId, { is_draft: newDraft });
      useNotesContentStore.setState((s) => {
        const updated: Record<string, ApiNote[]> = {};
        for (const [k, list] of Object.entries(s.notes)) {
          updated[k] = list.map((n) => (n.id === activeNoteId ? { ...n, is_draft: newDraft } : n));
        }
        return { notes: updated };
      });
      useDraftVersionStore.getState().bump();
    } catch (e) {
      console.error("draft toggle failed", e);
    }
  }

  async function handlePublishPublic() {
    if (!activeNote || !activeNoteId || activeNoteId < 0) return;
    const wasDraft = activeNote.is_draft;
    useNotesContentStore.setState((s) => {
      const updated: Record<string, ApiNote[]> = {};
      for (const [k, list] of Object.entries(s.notes)) {
        updated[k] = list.map((n) =>
          n.id === activeNoteId ? { ...n, is_public: true, is_draft: false } : n,
        );
      }
      return { notes: updated };
    });
    setLocalIsPublic(true);
    if (wasDraft) useDraftVersionStore.getState().bump();
    try {
      await apiPatchNote(activeNoteId, { is_public: true, is_draft: false });
    } catch (e) {
      console.error("publish public failed", e);
    }
  }

  async function handlePublishPrivate() {
    if (!activeNote || !activeNoteId || activeNoteId < 0) return;
    const wasDraft = activeNote.is_draft;
    useNotesContentStore.setState((s) => {
      const updated: Record<string, ApiNote[]> = {};
      for (const [k, list] of Object.entries(s.notes)) {
        updated[k] = list.map((n) =>
          n.id === activeNoteId ? { ...n, is_public: false, is_draft: false } : n,
        );
      }
      return { notes: updated };
    });
    setLocalIsPublic(false);
    if (wasDraft) useDraftVersionStore.getState().bump();
    try {
      await apiPatchNote(activeNoteId, { is_public: false, is_draft: false });
    } catch (e) {
      console.error("publish private failed", e);
    }
  }

  async function handleUnpublish() {
    if (!activeNote || !activeNoteId || activeNoteId < 0) return;
    useNotesContentStore.setState((s) => {
      const updated: Record<string, ApiNote[]> = {};
      for (const [k, list] of Object.entries(s.notes)) {
        updated[k] = list.map((n) =>
          n.id === activeNoteId ? { ...n, is_public: false, is_draft: true } : n,
        );
      }
      return { notes: updated };
    });
    setLocalIsPublic(false);
    useDraftVersionStore.getState().bump();
    try {
      await apiPatchNote(activeNoteId, { is_public: false, is_draft: true });
    } catch (e) {
      console.error("unpublish failed", e);
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
              position: "relative",
            }
      }
    >
      {/* Header bar — full variant only */}
      {!embedded && (
      <>
      {/* Right-side floating island — EditedChip ("Edited Xm ago" + hover
          activity popover) + PublishButton. Mirrors the left action island
          shape (rounded pill, backdrop blur, thin padding) so the top-bar
          reads as two matched islands. */}
      {activeNote && activeNoteId && activeNoteId > 0 && (
        <div style={{
          position: "absolute", top: 14, right: 14, zIndex: 20,
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <EditedChip
            updatedAt={activeNote.updated_at}
            createdAt={activeNote.created_at}
          />
          <PublishButton
            visibility={
              activeNote.is_public
                ? "public"
                : activeNote.is_draft
                  ? "draft"
                  : "private"
            }
            onPublishPublic={handlePublishPublic}
            onPublishPrivate={handlePublishPrivate}
            onUnpublish={handleUnpublish}
          />
        </div>
      )}
      {/* Top fade — content scrolls under the floating action pill so the
          first lines dissolve into the page bg instead of slamming into the
          toolbar. Apple-Notes feel. Pointer-events off so clicks pass to the
          editor underneath. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 84,
          background:
            "linear-gradient(to bottom, var(--gooni-card, #FFFFFF) 35%, rgba(255,255,255,0) 100%)",
          pointerEvents: "none",
          zIndex: 5,
        }}
      />
      <div
        style={{
          // Floating action island — moved to LEFT side per Daniel's
          // persistent-top-bar redesign. Title now sticks at the center
          // via a position:sticky wrapper inside the scroll content; the
          // island stays absolute over the editor wrapper.
          position: "absolute",
          top: 14,
          left: 14,
          zIndex: 10,
          maxWidth: "calc(60% - 28px)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 6px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.82)",
          backdropFilter: "blur(22px) saturate(1.8)",
          WebkitBackdropFilter: "blur(22px) saturate(1.8)",
          boxShadow:
            "0 4px 18px rgba(15,23,42,0.08), 0 0 0 0.5px rgba(15,23,42,0.06)",
        }}
      >
        {/* Save status — only render when actively saving or errored. The
            date line above the title shows last-saved timestamp, so the
            steady-state "Saved …" pill text is redundant noise. */}
        {(saveStatus === "saving" || saveStatus === "error") && (
          <span
            title={saveStatus === "error" ? "Save failed — changes are still in the editor. Retrying on next edit." : "Saving…"}
            style={{
              fontSize: 11.5,
              padding: "0 6px",
              color: saveStatus === "error" ? "#FF3B30" : "#8E8E93",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              transition: "color 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            {saveStatus === "saving" ? "Saving…" : "Save failed"}
          </span>
        )}

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
                      // Pick the neighbor BEFORE delete so the route doesn't
                      // briefly fall back to All Notes. Prefer the next note
                      // in the same space's list; if the deleted note was
                      // last, fall back to the previous one. If the space is
                      // empty after the delete, activeNoteId will go null
                      // and the editor will show the empty state — same as
                      // before.
                      const space = selectedSpaceId ?? "general";
                      const list = useNotesContentStore.getState().notes[space] ?? [];
                      const idx = list.findIndex((n) => n.id === activeNote.id);
                      const neighbor = idx >= 0
                        ? (list[idx + 1] ?? list[idx - 1] ?? null)
                        : null;
                      // Suppress save-on-leave for the about-to-be-deleted
                      // note — it would 404 (or worse, recreate state on the
                      // server). Clearing hasChanges makes the leave-effect's
                      // gate skip the PATCH.
                      hasChanges.current = false;
                      await deleteNote(activeNote.id, space);
                      setDeleteConfirm(false);
                      if (neighbor) {
                        selectNote(neighbor.id);
                        navigate({ to: "/", search: { note: neighbor.id, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: undefined } });
                      }
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

        {/* Tag-to-backlog — sends the note (title or first line) into the
            Gooni Backlog list as a list_item, with source_note_id pointing
            back here. Same 30×30 visual family as Pin/Public. Pulses green
            briefly after a successful tag so the user gets confirmation
            without a full toast modal. Conflict-check on the backend
            handles dedupe — repeated clicks just surface as duplicates,
            won't stack rows. */}
        {activeNote && activeNoteId && activeNoteId > 0 && (
          <Tooltip label={taggedNoteId === activeNoteId ? "Tagged to backlog" : "Tag to Gooni backlog"}>
            <button
              onClick={async () => {
                if (!activeNoteId || activeNoteId < 0 || taggingInFlight) return;
                const titleClean = (localTitle ?? activeNote?.title ?? "").trim();
                const bodyText = bodyRef.current
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim();
                const firstLine = bodyText.slice(0, 120);
                const text = titleClean || firstLine;
                if (!text) return; // nothing to tag yet
                setTaggingInFlight(true);
                try {
                  // Backlog tickets live in `backlog_tickets` (post the focus/
                  // todo/backlog extraction) — not list_items. Hitting
                  // /lists/{id}/items is a no-op for the board, which was the
                  // bug. Backend dedupes idempotently on source_note_id so
                  // repeat clicks return the existing ticket.
                  const { createBacklogTicket } = await import("../../services/api");
                  await createBacklogTicket(text, {
                    source_note_id: activeNoteId,
                    subtitle: titleClean && firstLine !== titleClean ? firstLine : null,
                  });
                  setTaggedNoteId(activeNoteId);
                  setTimeout(() => {
                    setTaggedNoteId((curr) => (curr === activeNoteId ? null : curr));
                  }, 1600);
                } catch (e) {
                  console.error("tag-to-backlog failed", e);
                } finally {
                  setTaggingInFlight(false);
                }
              }}
              disabled={taggingInFlight}
              style={{
                width: 30, height: 30, borderRadius: 8,
                border: "none",
                background: taggedNoteId === activeNoteId ? "rgba(52,199,89,0.16)" : "transparent",
                cursor: taggingInFlight ? "wait" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, flexShrink: 0,
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { if (taggedNoteId !== activeNoteId) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
              onMouseLeave={(e) => { if (taggedNoteId !== activeNoteId) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              {taggedNoteId === activeNoteId
                ? <Check size={15} strokeWidth={2} color="#16A34A" />
                : <ListPlus size={15} strokeWidth={1.7} color="#636366" />}
            </button>
          </Tooltip>
        )}

        {/* Draft toggle — marks the note as "intent to publish, in progress."
            Surfaces in the sidebar's DRAFTS section. Independent of pin/public:
            a draft can also be pinned. Auto-clears on the backend the moment
            the user flips Public on (it shipped → no longer a draft). */}
        {activeNote && activeNoteId && activeNoteId > 0 && (
          <Tooltip label={activeNote.is_draft ? "Remove draft mark" : "Mark as draft (intent to publish)"}>
            <button
              onClick={handleToggleDraft}
              style={{
                width: 30, height: 30, borderRadius: 8,
                border: "none",
                background: activeNote.is_draft ? "rgba(139,92,246,0.16)" : "transparent",
                cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0, flexShrink: 0,
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { if (!activeNote.is_draft) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
              onMouseLeave={(e) => { if (!activeNote.is_draft) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <PencilIcon
                size={15}
                strokeWidth={1.7}
                color={activeNote.is_draft ? "#8B5CF6" : "#636366"}
              />
            </button>
          </Tooltip>
        )}

        {/* Globe publish toggle removed — PublishButton (top-right) is the
            primary publish surface; keeping a second toggle here was visual
            noise. Viewer-count chip kept below as informational only. */}

        {/* Viewer count — only when published. Optimistic-render falls back
            to "—" while unique_viewers hydrates from the single-note GET. */}
        {activeNote && activeNoteId && activeNoteId > 0 && localIsPublic && (
          <Tooltip label="Unique visitors who hit the public page">
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "0 8px", height: 30, borderRadius: 8,
              fontSize: 12, color: "#6E6E73",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              userSelect: "none",
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span>{typeof activeNote.unique_viewers === "number" ? activeNote.unique_viewers.toLocaleString() : "—"}</span>
            </div>
          </Tooltip>
        )}

        </div>

        {/* Truncated note title — Notion-style top-left navbar label. Sits
            beside the action icons in the floating island so the title
            stays visible when the user scrolls past the body H1. Click
            focuses the in-body title input. */}
        {activeNote && (localTitle?.trim() || activeNote.title?.trim()) && (
          <>
            <div style={{
              width: 1, height: 16,
              background: "rgba(15,23,42,0.10)",
              flexShrink: 0,
              margin: "0 4px",
            }} />
            <button
              onClick={() => titleInputRef.current?.focus()}
              title={localTitle || activeNote.title || ""}
              style={{
                background: "transparent",
                border: "none",
                padding: "0 6px",
                cursor: "pointer",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: 12.5,
                fontWeight: 500,
                color: "#1C1C1E",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                maxWidth: 280,
                textAlign: "left",
                lineHeight: 1.4,
              }}
            >
              {localTitle || activeNote.title}
            </button>
          </>
        )}
      </div>
      </>
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
            minHeight: embeddedFocused ? 220 : 80 + 18 * 2,
            overflow: "hidden",
            borderRadius: 14,
            transition: "min-height 280ms cubic-bezier(0.22, 0.61, 0.36, 1)",
          }}
        >
            <div
              style={{ position: "relative", zIndex: 1 }}
              onDrop={async (e) => {
                const all = Array.from(e.dataTransfer?.files ?? []);
                if (!all.length || !editor) return;
                e.preventDefault();
                // Drop-coordinate-aware insert (Notion-style inline).
                const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
                if (coords) editor.chain().focus().setTextSelection(coords.pos).run();
                const noteIdForUpload = activeNoteId && activeNoteId > 0 ? activeNoteId : undefined;
                for (const file of all) {
                  if (file.type.startsWith("image/")) {
                    await uploadAndInsertImage(editor, file);
                  } else {
                    await uploadAndInsertAttachment(editor, file, noteIdForUpload);
                  }
                  hasChanges.current = true;
                  scheduleSave();
                }
              }}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
                  e.preventDefault();
                }
              }}
              onPaste={async (e) => {
                if (!editor) return;
                // URL paste → LinkCard (Slack/Confluence smartcard).
                // Sync detect + preventDefault first; only then await.
                const text = e.clipboardData?.getData("text/plain") ?? "";
                const trimmed = text.trim();
                if (URL_PASTE_RE.test(trimmed)) {
                  e.preventDefault();
                  await pasteAsLinkCardIfUrl(editor, trimmed);
                  hasChanges.current = true;
                  scheduleSave();
                  return;
                }
                // File paste — existing path.
                const all = Array.from(e.clipboardData?.files ?? []);
                if (!all.length) return;
                e.preventDefault();
                const noteIdForUpload = activeNoteId && activeNoteId > 0 ? activeNoteId : undefined;
                for (const file of all) {
                  if (file.type.startsWith("image/")) {
                    await uploadAndInsertImage(editor, file);
                  } else {
                    await uploadAndInsertAttachment(editor, file, noteIdForUpload);
                  }
                  hasChanges.current = true;
                  scheduleSave();
                }
              }}
            >
              <EditorContent editor={editor} />
            </div>

            {/* Submit button — uses the shared SendButton so the composer
                and chat InputBar share one source of truth (#122-124). The
                anchor wrapper handles the absolute positioning that's
                specific to the embedded composer card. */}
            <div style={{ position: "absolute", bottom: 10, right: 10 }}>
              <SendButton
                ref={submitButtonRef}
                onClick={handleSubmit}
                disabled={editorEmpty}
                title="Submit (Enter)"
                ariaLabel="Submit note"
              />
            </div>
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
                navigate({ to: "/", search: { note: undefined, conv: undefined, list: backlog.id , audit: undefined, segment: undefined, view: undefined} });
              }
            } catch (e) { console.error(e); }
          };
          const openNote = () => {
            navigate({ to: "/", search: { note: embeddedToast.noteId, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined} });
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
          style={{ flex: 1, overflowY: "auto", boxSizing: "border-box", width: "100%", position: "relative" }}
        >
          {/* Outline panel — Notion-style left rail. Absolute-positioned
              inside the scroll container so it doesn't take a flex slot
              and the editor's centered max-width content layout stays
              intact. Hides itself when fewer than 2 headings exist. */}
          {!embedded && (
            <div style={{ position: "absolute", top: 0, left: 16, height: "100%", pointerEvents: "none" }}>
              <div style={{ pointerEvents: "auto" }}>
                <OutlinePanel editor={editor} />
              </div>
            </div>
          )}
          <div style={{ maxWidth: 780, width: "100%", margin: "0 auto", padding: "72px 72px 48px", boxSizing: "border-box" }}>
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
                {/* Parent backlink — only when this note was extracted from
                    another. Click jumps back to the parent (which still has
                    the NoteLink chip pointing here, so navigation round-trips
                    naturally). */}
                {parentLink && (
                  <button
                    onClick={async () => {
                      await save();
                      selectNote(parentLink.id);
                      navigate({ to: "/", search: { note: parentLink.id, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: undefined } });
                    }}
                    title={`Back to "${parentLink.title}"`}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      padding: "2px 10px 2px 8px", marginBottom: 12,
                      background: "rgba(74,222,128,0.10)",
                      color: "#16803C",
                      border: "0.5px solid rgba(22,128,60,0.25)",
                      borderRadius: 12,
                      fontSize: 12.5,
                      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                      cursor: "pointer",
                      maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      transition: "background 0.12s, border-color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "rgba(74,222,128,0.18)";
                      (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(22,128,60,0.45)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "rgba(74,222,128,0.10)";
                      (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(22,128,60,0.25)";
                    }}
                  >
                    <span aria-hidden="true">↖</span>
                    <span>from “{parentLink.title}”</span>
                  </button>
                )}
                {/* Title + meta header — no sticky wrapper. Title scrolls
                    naturally with the body; the truncated copy on the
                    left-island floating pill keeps it visible after
                    scroll. Top margin clears the floating top islands
                    (action pill + publish/edited pill, both at top:14).
                    Icon picker removed — title is flush left, big bold. */}
                <div style={{ marginTop: 52, marginBottom: 2 }}>
                  <input
                    ref={titleInputRef}
                    value={localTitle}
                    onChange={handleTitleChange}
                    onBlur={save}
                    onKeyDown={handleTitleKeyDown}
                    placeholder="Title"
                    style={{
                      width: "100%",
                      fontSize: 30,
                      fontWeight: 700,
                      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
                      color: "var(--gooni-text, #1C1C1E)",
                      border: "none",
                      outline: "none",
                      background: "transparent",
                      padding: 0,
                      lineHeight: 1.2,
                      letterSpacing: "-0.5px",
                      textAlign: "left",
                    }}
                  />
                </div>
                {/* Tags row — date moved to right-island EditedChip. Lowercase
                    #tag pills w/ subtle bg, hover reveals remove affordance.
                    Tight to title above, breathing room below before body. */}
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 22,
                    fontSize: 12,
                    color: "var(--gooni-muted, #8E8E93)",
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                    letterSpacing: 0.1,
                  }}
                >
                  {localTags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => removeTag(tag)}
                      title={`Remove tag "${tag}"`}
                      style={{
                        fontSize: 11.5,
                        fontWeight: 500,
                        color: "var(--gooni-muted, #8E8E93)",
                        background: "rgba(15,23,42,0.04)",
                        border: "none",
                        padding: "2px 8px",
                        borderRadius: 999,
                        cursor: "pointer",
                        transition: "background 0.12s, color 0.12s",
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.10)";
                        (e.currentTarget as HTMLButtonElement).style.color = "#B91C1C";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.04)";
                        (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)";
                      }}
                    >
                      #{tag}
                    </button>
                  ))}
                  {tagInputOpen ? (
                    <input
                      autoFocus
                      value={newTagDraft}
                      onChange={(e) => setNewTagDraft(e.target.value)}
                      onBlur={addTagFromDraft}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTagFromDraft();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setNewTagDraft("");
                          setTagInputOpen(false);
                        }
                      }}
                      placeholder="tag"
                      style={{
                        fontSize: 11.5,
                        fontWeight: 500,
                        color: "var(--gooni-text, #1C1C1E)",
                        background: "rgba(15,23,42,0.06)",
                        border: "none",
                        outline: "none",
                        padding: "2px 8px",
                        borderRadius: 999,
                        width: 90,
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => setTagInputOpen(true)}
                      title="Add tag"
                      style={{
                        fontSize: 11.5,
                        fontWeight: 500,
                        color: "rgba(142,142,147,0.55)",
                        background: "transparent",
                        border: "none",
                        padding: "2px 6px",
                        borderRadius: 999,
                        cursor: "pointer",
                        transition: "background 0.12s, color 0.12s",
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.04)";
                        (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                        (e.currentTarget as HTMLButtonElement).style.color = "rgba(142,142,147,0.55)";
                      }}
                    >
                      + tag
                    </button>
                  )}
                </div>
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
                        navigate({ to: "/", search: { note: undefined, conv: undefined, list: backlog.id , audit: undefined, segment: undefined, view: undefined} });
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
                    // Hide the text-format menu when a node-style block owns
                    // its own controls — figure nodes (images) bring their
                    // own resize/align/caption widget, so the formatting bar
                    // stacking on top is just visual noise.
                    shouldShow={({ editor, from, to }) => {
                      if (editor.isActive("figure") || editor.isActive("image")) return false;
                      return from !== to;
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      background: "#FFFFFF",
                      borderRadius: 12,
                      padding: "5px 6px",
                      gap: 2,
                      // Apple-Notes selection-toolbar feel: soft elevation,
                      // hairline border so it reads as paper floating above
                      // the editor surface, no harsh dark slab.
                      boxShadow:
                        "0 8px 22px rgba(15,23,42,0.14), 0 1px 3px rgba(15,23,42,0.10), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
                    }}
                  >
                    {/* H1/H2 leading the menu so highlighted text can be
                        promoted to a heading without remembering the slash
                        command. Followed by inline marks. Heading levels are
                        capped at [1, 2] in the StarterKit config above. */}
                    {([
                      { Icon: Heading1,      title: "Heading 1",   action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(), active: editor.isActive("heading", { level: 1 }) },
                      { Icon: Heading2,      title: "Heading 2",   action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), active: editor.isActive("heading", { level: 2 }) },
                      { Icon: BoldIcon,      title: "Bold",        action: () => editor.chain().focus().toggleBold().run(),    active: editor.isActive("bold") },
                      { Icon: ItalicIcon,    title: "Italic",      action: () => editor.chain().focus().toggleItalic().run(),  active: editor.isActive("italic") },
                      { Icon: Strikethrough, title: "Strike",      action: () => editor.chain().focus().toggleStrike().run(),  active: editor.isActive("strike") },
                      { Icon: CodeIcon,      title: "Inline code", action: () => editor.chain().focus().toggleCode().run(),    active: editor.isActive("code") },
                      // Card block — wraps the selected paragraphs in one
                      // full-width pastel panel. Clicking again lifts them
                      // back out. CheckCircle2 toggles checked; Droplet cycles
                      // color (cmd+click on the card body also toggles check).
                      {
                        Icon: StickyNote,
                        title: editor.isActive("noteCard") ? "Remove card" : "Card",
                        action: () => editor.chain().focus().toggleNoteCard().run(),
                        active: editor.isActive("noteCard"),
                      },
                      {
                        Icon: CheckCircle2,
                        title: editor.isActive("noteCard", { checked: true })
                          ? "Mark card undone"
                          : "Mark card done",
                        action: () =>
                          editor
                            .chain()
                            .focus()
                            .setNoteCardChecked(!editor.isActive("noteCard", { checked: true }))
                            .run(),
                        active: editor.isActive("noteCard", { checked: true }),
                        // Only meaningful when cursor is inside an existing card.
                        hidden: !editor.isActive("noteCard"),
                      },
                      {
                        // Cycle card color blue ↔ pink. Only shown inside a card.
                        Icon: Droplet,
                        title: "Cycle card color",
                        action: () => editor.chain().focus().cycleNoteCardColor().run(),
                        active: false,
                        hidden: !editor.isActive("noteCard"),
                      },
                    ] as const).filter((item) => !("hidden" in item && item.hidden)).map((item) => (
                      <button
                        key={item.title}
                        title={item.title}
                        onMouseDown={(e) => { e.preventDefault(); item.action(); }}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          width: 30, height: 30,
                          padding: 0,
                          borderRadius: 8,
                          border: "none",
                          background: item.active ? "rgba(15,23,42,0.08)" : "transparent",
                          color: item.active ? "#0F172A" : "#475569",
                          cursor: "pointer",
                          transition: "background 0.12s, color 0.12s",
                        }}
                        onMouseEnter={(e) => {
                          if (!item.active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.05)";
                        }}
                        onMouseLeave={(e) => {
                          if (!item.active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                        }}
                      >
                        <item.Icon size={15} strokeWidth={1.9} />
                      </button>
                    ))}
                    {/* Text-color swatches. Minimal: a row of small filled
                        circles + a reset dot. Click applies via the TextColor
                        mark. Active color shows a ring. Always visible —
                        Daniel didn't want a popover, wants the picker flat
                        in the toolbar. */}
                    <span style={{ width: 1, height: 18, background: "rgba(15,23,42,0.10)", margin: "0 4px" }} />
                    {TEXT_COLOR_PALETTE.map((sw) => {
                      const isActive = sw.value == null
                        ? !editor.isActive("textColor")
                        : editor.isActive("textColor", { color: sw.value });
                      return (
                        <button
                          key={sw.name}
                          title={sw.label}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            editor.chain().focus().setTextColor(sw.value).run();
                          }}
                          style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            width: 22, height: 22,
                            padding: 0,
                            borderRadius: "50%",
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                          }}
                        >
                          <span
                            style={{
                              display: "inline-block",
                              width: 14, height: 14, borderRadius: "50%",
                              background: sw.value ?? "transparent",
                              border: sw.value
                                ? (isActive ? "2px solid #0F172A" : "0.5px solid rgba(15,23,42,0.18)")
                                : "1.5px solid rgba(15,23,42,0.35)",
                              boxSizing: "border-box",
                              // Diagonal slash on the "default" (null) swatch so
                              // it reads as "clear" not "white".
                              position: "relative",
                            }}
                          >
                            {sw.value == null && (
                              <span
                                style={{
                                  position: "absolute", left: "50%", top: "50%",
                                  transform: "translate(-50%, -50%) rotate(-45deg)",
                                  width: 12, height: 1.5, background: "rgba(15,23,42,0.5)",
                                }}
                              />
                            )}
                          </span>
                        </button>
                      );
                    })}
                    {/* Vertical separator before the structural action — keeps
                        the formatting marks visually grouped. */}
                    {activeNoteId && activeNoteId > 0 && (
                      <>
                        <span style={{ width: 1, height: 18, background: "rgba(15,23,42,0.10)", margin: "0 4px" }} />
                        <button
                          title={extractInFlight ? "Extracting…" : "Extract to new linked note"}
                          disabled={extractInFlight}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            if (extractInFlight) return;
                            void handleExtractToChildNote();
                          }}
                          style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            gap: 4,
                            height: 30,
                            padding: "0 10px",
                            borderRadius: 8,
                            border: "none",
                            background: "transparent",
                            color: extractInFlight ? "#94A3B8" : "#475569",
                            cursor: extractInFlight ? "wait" : "pointer",
                            fontSize: 12,
                            fontWeight: 500,
                            transition: "background 0.12s, color 0.12s",
                            opacity: extractInFlight ? 0.7 : 1,
                          }}
                          onMouseEnter={(e) => {
                            if (extractInFlight) return;
                            e.currentTarget.style.background = "rgba(15,23,42,0.05)";
                            e.currentTarget.style.color = "#0F172A";
                          }}
                          onMouseLeave={(e) => {
                            if (extractInFlight) return;
                            e.currentTarget.style.background = "transparent";
                            e.currentTarget.style.color = "#475569";
                          }}
                        >
                          {extractInFlight ? (
                            // CSS-only spinner — matches the rest of the editor
                            // chrome's no-extra-deps rule. Border-top animates
                            // around a transparent rest of the ring.
                            <span
                              style={{
                                width: 12, height: 12, borderRadius: "50%",
                                border: "1.5px solid rgba(15,23,42,0.15)",
                                borderTopColor: "rgba(15,23,42,0.55)",
                                animation: "gooni-spin 0.7s linear infinite",
                              }}
                            />
                          ) : (
                            <CornerUpRight size={13} strokeWidth={1.9} />
                          )}
                          {extractInFlight ? "Extracting…" : "Extract"}
                        </button>
                      </>
                    )}
                  </BubbleMenu>
                )}

                <div
                  onDrop={async (e) => {
                    const all = Array.from(e.dataTransfer?.files ?? []);
                    if (!all.length || !editor) return;
                    e.preventDefault();
                    // Move the cursor to the drop coordinates BEFORE inserting
                    // so the attachment lands where the user dropped it
                    // (Notion-style inline), not at whatever the prior cursor
                    // position was. posAtCoords returns null if the drop missed
                    // a renderable position — fall back to current selection.
                    const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
                    if (coords) editor.chain().focus().setTextSelection(coords.pos).run();
                    const noteIdForUpload = activeNoteId && activeNoteId > 0 ? activeNoteId : undefined;
                    for (const file of all) {
                      if (file.type.startsWith("image/")) {
                        await uploadAndInsertImage(editor, file);
                      } else {
                        await uploadAndInsertAttachment(editor, file, noteIdForUpload);
                      }
                      hasChanges.current = true;
                      scheduleSave();
                    }
                  }}
                  onDragOver={(e) => {
                    if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
                      e.preventDefault();
                    }
                  }}
                  onPaste={async (e) => {
                    if (!editor) return;
                    // URL paste → LinkCard. Same logic as embedded variant.
                    const text = e.clipboardData?.getData("text/plain") ?? "";
                    const trimmed = text.trim();
                    if (URL_PASTE_RE.test(trimmed)) {
                      e.preventDefault();
                      await pasteAsLinkCardIfUrl(editor, trimmed);
                      hasChanges.current = true;
                      scheduleSave();
                      return;
                    }
                    const all = Array.from(e.clipboardData?.files ?? []);
                    if (!all.length) return;
                    e.preventDefault();
                    const noteIdForUpload = activeNoteId && activeNoteId > 0 ? activeNoteId : undefined;
                    for (const file of all) {
                      if (file.type.startsWith("image/")) {
                        await uploadAndInsertImage(editor, file);
                      } else {
                        await uploadAndInsertAttachment(editor, file, noteIdForUpload);
                      }
                      hasChanges.current = true;
                      scheduleSave();
                    }
                  }}
                >
                  <EditorContent editor={editor} />
                </div>

                <NoteMemoriesPanel memories={noteMemories} />

                {activeNote?.id && activeNote.id > 0 ? (
                  <div style={{ marginTop: 16, paddingLeft: 4 }}>
                    <ReactionBar targetType="note" targetId={activeNote.id} />
                  </div>
                ) : null}

                {activeNote?.id && activeNote.id > 0 ? (
                  <NoteComments noteId={activeNote.id} />
                ) : null}

              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
