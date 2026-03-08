import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef } from "react";
import { useJarvisStore } from "../../stores/useJarvisStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";

export function NoteEditor() {
  const { notes, activeNoteId, updateNote } = useNotesContentStore();
  const { isOpen: jarvisOpen } = useJarvisStore();

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: {
      attributes: {
        style: [
          "font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          "font-size: 16px",
          "line-height: 1.6",
          "color: #0f1419",
          "outline: none",
          "min-height: 60px",
        ].join("; "),
      },
    },
  });

  const activeNote = activeNoteId ? (notes.notes["1"] as any)?.find((n: any) => n.id === activeNoteId) : null;

  // Auto-save timer
  const saveTimeoutRef = useRef<number>();

  // Load active note content into editor
  useEffect(() => {
    if (activeNote) {
      editor?.commands.setContent(activeNote.content);
      editor?.commands.focus("end");
    } else {
      editor?.commands.clearContent();
    }
  }, [activeNoteId, editor]);

  // Auto-save logic
  const triggerSave = useCallback(() => {
    const title = "";
    const content = editor?.state.doc.textContent.trim() ?? "";

    if (content && activeNoteId) {
      updateNote(activeNoteId, title, content);
    }
  }, [activeNoteId, updateNote]);

  // Debounced save with typing detection
  useEffect(() => {
    const handleInput = () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        triggerSave();
      }, 1500);
    };

    if (editor) {
      editor.on("update", handleInput);
    }

    return () => {
      if (editor) {
        editor.off("update", handleInput);
      }
    };
  }, [editor, triggerSave]);

  // Tab behavior: Tab from title → focus body
  useEffect(() => {
    const handleKeyDown = (e: Event) => {
      const keyboardEvent = e as KeyboardEvent;
      if (keyboardEvent.key === "Tab" && !keyboardEvent.shiftKey) {
        keyboardEvent.preventDefault();
        editor?.commands.focus("end");
      }
    };

    const titleElement = document.querySelector(`[data-tip-tap-title]`);
    const bodyElement = document.querySelector(`[data-tip-tap-body]`);

    if (titleElement && bodyElement) {
      titleElement.addEventListener("keydown", handleKeyDown);
      bodyElement.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      if (titleElement && bodyElement) {
        titleElement.removeEventListener("keydown", handleKeyDown);
        bodyElement.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [editor]);

  if (activeNoteId === null) {
    return (
      <div style={{
        padding: "32px",
        textAlign: "center",
        color: "#aab8c2",
        fontSize: 14,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
      }}>
        Select a note or press + to create one
      </div>
    );
  }

  return (
    <div style={{ flex: 1, height: "100vh", backgroundColor: "#FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Title input */}
      <div
        style={{
          padding: "16px 32px",
          borderBottom: "1px solid rgba(0,0,0,0.08)",
        }}
      >
        <input
          type="text"
          value={activeNote?.title || ""}
          onChange={(e) => {
            const title = e.target.value;
            if (activeNoteId) {
              updateNote(activeNoteId, title, activeNote.content || "");
            }
          }}
          placeholder="Untitled"
          style={{
            width: "100%",
            fontSize: "28px",
            fontWeight: 700,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "#0f1419",
          }}
        />
      </div>

      {/* Body editor */}
      <div style={{ flex: 1, padding: "0 32px" }}>
        <EditorContent editor={editor} />
      </div>

      {/* Jarvis hint when closed */}
      {!jarvisOpen && (
        <div style={{
          padding: "16px 32px",
          textAlign: "center",
          color: "#8E8E93",
          fontSize: 13,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        }}>
          💬 Jarvis is ready to discuss your notes
        </div>
      )}
    </div>
  );
}
