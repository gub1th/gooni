import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useJarvisStore } from "../../stores/useJarvisStore";

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

function formatNoteDate(iso: string): string {
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

export function NoteEditor() {
  useEditorStyles();

  const { selectedSpaceId, notes, activeNoteId, updateNote } = useNotesContentStore();
  const { isOpen: jarvisOpen, toggle: toggleJarvis } = useJarvisStore();

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  const [localTitle, setLocalTitle] = useState(activeNote?.title ?? "");
  const bodyRef = useRef<string>(activeNote?.content ?? "");
  const titleRef = useRef<string>(activeNote?.title ?? "");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalTitle(activeNote?.title ?? "");
    bodyRef.current = activeNote?.content ?? "";
    titleRef.current = activeNote?.title ?? "";
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
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

  function save() {
    if (!activeNoteId || activeNoteId < 0) return;
    updateNote(activeNoteId, titleRef.current, bodyRef.current);
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
            color: "#8E8E93",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          }}
        >
          {activeNote ? formatNoteDate(activeNote.updated_at) : ""}
        </span>

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
        </div>
      )}
    </div>
  );
}
