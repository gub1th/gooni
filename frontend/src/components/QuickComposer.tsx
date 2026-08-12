import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { createNote as apiCreateNote } from "../services/api";
import { SendButton } from "./chat/SendButton";
import { FONT, z} from "../ui";


// Cmd+E quick-capture composer. Mounted at root (next to QuickNav) so it
// works on every view, including /public/* where the sidebar isn't around.
//
// Saves directly to the General space via apiCreateNote. Dispatches a
// `gooni:note-created` window event on save so the Dashboard (if mounted)
// can refetch stats — the dashboard's recent-notes list is its own state,
// not driven by react-query.
//
// Body-only by design — Daniel wants the dashboard composer's shape (no
// title field). The classifier auto-titles after embedding, so leaving
// title null isn't a regression.
export function QuickComposer() {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor(
    {
      extensions: [StarterKit, Image],
      content: "",
      autofocus: false,
      editorProps: {
        attributes: {
          style: [
            "font-family: " + FONT,
            "font-size: 14.5px",
            "line-height: 1.65",
            "color: var(--gooni-text, #1C1C1E)",
            "outline: none",
            "min-height: 120px",
          ].join("; "),
          class: "gooni-quick-composer",
        },
      },
    },
    [open],
  );

  // Toggle on Cmd+E / Ctrl+E. Skip when the user is mid-typing in another
  // input/textarea/contenteditable so we don't hijack note-editor or chat
  // shortcuts. The composer itself sets contenteditable on the editor view,
  // but that's only relevant once the composer is open — and Cmd+E should
  // still close it from inside, so we let the meta-key bypass that guard.
  useEffect(() => {
    function isEditableTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "e" || e.key === "E")) {
        if (!open && isEditableTarget(e.target)) return;
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Fresh editor per open: reset state, focus, ready.
  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setSavedFlash(false);
      return;
    }
    requestAnimationFrame(() => editor?.commands.focus("end"));
  }, [open, editor]);

  async function handleSubmit() {
    if (!editor || editor.isEmpty || submitting) return;
    setSubmitting(true);
    const content = editor.getHTML();
    try {
      await apiCreateNote("general", { content });
      window.dispatchEvent(new CustomEvent("gooni:note-created"));
      setSavedFlash(true);
      // Brief flash so the user sees the save landed before the modal closes.
      setTimeout(() => setOpen(false), 360);
    } catch (err) {
      console.error("[QuickComposer] save failed:", err);
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <style>{`
        .gooni-quick-composer p { margin: 0 0 10px; }
        .gooni-quick-composer p:last-child { margin-bottom: 0; }
        .gooni-quick-composer h1 { font-size: 1.4em; font-weight: 700; margin: 0.4em 0 0.3em; }
        .gooni-quick-composer h2 { font-size: 1.2em; font-weight: 700; margin: 0.4em 0 0.3em; }
        .gooni-quick-composer ul, .gooni-quick-composer ol { padding-left: 20px; margin: 0 0 10px; }
        .gooni-quick-composer code { background: rgba(15,23,42,0.06); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
        .gooni-quick-composer pre { background: #0F172A; color: #F1F5F9; padding: 12px 14px; border-radius: 8px; margin: 10px 0; overflow-x: auto; }
        .gooni-quick-composer img { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 6px 0; }
        .gooni-quick-composer.is-empty > p:first-child::before {
          content: "Quick note…";
          color: var(--gooni-muted, #AEAEB2);
          pointer-events: none;
          position: absolute;
        }
      `}</style>
      <div
        onClick={() => setOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: z.modalScrim, // ladder tier — a literal here sat under the ambient chrome
          background: "rgba(15,15,18,0.42)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: "14vh",
          fontFamily: FONT,
        }}
      >
        <div
          ref={containerRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 560,
            maxWidth: "92vw",
            background: "var(--gooni-card, #FFFFFF)",
            borderRadius: 14,
            boxShadow: "0 24px 60px rgba(0,0,0,0.32), 0 4px 12px rgba(0,0,0,0.12)",
            border: "1px solid rgba(0,0,0,0.06)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "relative",
              padding: "20px 22px 16px",
              minHeight: 140,
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (!files.length || !editor) return;
              e.preventDefault();
              files.forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") {
                    editor.chain().focus().setImage({ src: reader.result }).run();
                  }
                };
                reader.readAsDataURL(file);
              });
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (!files.length || !editor) return;
              e.preventDefault();
              files.forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") {
                    editor.chain().focus().setImage({ src: reader.result }).run();
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
          >
            <EditorContent editor={editor} />
            <div style={{ position: "absolute", bottom: 12, right: 12 }}>
              <SendButton
                onClick={handleSubmit}
                disabled={!editor || editor.isEmpty || submitting}
                title={savedFlash ? "Saved" : "Save (⌘↵)"}
                ariaLabel="Save quick note"
              />
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: 14,
              padding: "8px 14px",
              borderTop: "1px solid rgba(0,0,0,0.06)",
              fontSize: 11,
              color: "var(--gooni-muted, #8E8E93)",
              fontFamily: FONT,
            }}
          >
            <span>⌘↵ save</span>
            <span>⇧↵ newline</span>
            <span style={{ marginLeft: "auto" }}>{savedFlash ? "saved" : "esc to close"}</span>
          </div>
        </div>
      </div>
      {/* Cmd+Enter submit listener — bound to the document while open so it
          fires regardless of where focus is inside the modal. ProseMirror
          captures plain Enter for newlines, which we want. */}
      <SubmitOnCmdEnter onSubmit={handleSubmit} />
    </>
  );
}

function SubmitOnCmdEnter({ onSubmit }: { onSubmit: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "Enter") {
        e.preventDefault();
        onSubmit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSubmit]);
  return null;
}
