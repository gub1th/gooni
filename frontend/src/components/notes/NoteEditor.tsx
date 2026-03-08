import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotesStore } from "../../stores/notesStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";

export function NoteEditor() {
  const { selectedSpaceId } = useNotesStore();
  const { notes, activeNoteId, updateNote } = useNotesContentStore();
  const spaceId = selectedSpaceId || "general";
  const activeNote = useMemo(
    () => (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null,
    [notes, spaceId, activeNoteId]
  );

  const [localTitle, setLocalTitle] = useState("");
  const [localContent, setLocalContent] = useState("");
  const saveTimeoutRef = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    onUpdate: ({ editor: e }) => {
      setLocalContent(e.getText());
    },
    editorProps: {
      attributes: {
        style: "font-size:16px;line-height:1.6;outline:none;min-height:260px;",
      },
    },
  });

  useEffect(() => {
    const title = activeNote?.title ?? "";
    const content = activeNote?.content ?? "";
    setLocalTitle(title);
    setLocalContent(content);
    editor?.commands.setContent(content);
  }, [activeNote?.id, editor]);

  const flushSave = useCallback(() => {
    if (!activeNoteId) return;
    updateNote(activeNoteId, localTitle, localContent);
  }, [activeNoteId, localTitle, localContent, updateNote]);

  useEffect(() => {
    if (!activeNoteId) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = window.setTimeout(flushSave, 1500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [localTitle, localContent, activeNoteId, flushSave]);

  if (activeNoteId === null) {
    return <div style={{ height: "100%", display: "grid", placeItems: "center", color: "#8E8E93" }}>Select a note or press + to create one</div>;
  }

  return (
    <div style={{ height: "100%", padding: "24px 32px" }}>
      <input
        ref={titleRef}
        data-tip-tap-title
        value={localTitle}
        onChange={(e) => setLocalTitle(e.target.value)}
        onBlur={flushSave}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            editor?.commands.focus("start");
          }
        }}
        placeholder="Untitled"
        style={{ width: "100%", fontSize: 28, fontWeight: 700, border: "none", outline: "none", background: "transparent", marginBottom: 18 }}
      />
      <div onBlur={flushSave} data-tip-tap-body>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
