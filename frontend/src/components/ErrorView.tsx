import { useState } from "react";
import { RefreshCw, Home, ChevronDown, ChevronRight } from "lucide-react";
import { FONT } from "../ui";

// ErrorView — full-page fallback rendered by Tanstack Router's
// `errorComponent` slot. Replaces the default "Something went wrong"
// page with a Gooni-shaped surface + a collapsible technical detail
// block so the next bug report doesn't have to start with "the page
// just crashed."
//
// Mount via __root.tsx `errorComponent: ErrorView`.


interface Props {
  // Tanstack Router supplies `error` (unknown) + `reset` (() => void)
  // on its errorComponent. Typed loosely so the same component also
  // works as a React-only fallback if mounted elsewhere.
  error?: unknown;
  reset?: () => void;
}

export function ErrorView({ error, reset }: Props) {
  const [open, setOpen] = useState(false);
  const message = errorMessage(error);
  const stack = errorStack(error);

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "32px 24px",
      background: "var(--gooni-bg, #FAF7F0)",
      fontFamily: FONT,
    }}>
      <div style={{
        maxWidth: 480, width: "100%",
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 16,
        padding: "32px 28px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.06)",
        textAlign: "center",
      }}>
        <img
          src="/gooni-logo.svg"
          alt="Gooni"
          width={96} height={96}
          style={{ margin: "0 auto 16px", display: "block", filter: "saturate(0.6)" }}
        />
        <h1 style={{
          margin: "0 0 6px",
          fontSize: 22, fontWeight: 600,
          color: "var(--gooni-text, #1C1C1E)",
        }}>
          Gooni tripped on something
        </h1>
        <p style={{
          margin: "0 0 22px",
          fontSize: 14, lineHeight: 1.5,
          color: "var(--gooni-muted, #6B7280)",
        }}>
          The page hit a bug while rendering. Your data is fine — nothing was lost.
          Try reloading; if it keeps happening, the detail block below tells you
          what blew up.
        </p>

        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 18 }}>
          <button
            onClick={() => { reset?.(); window.location.reload(); }}
            style={primaryButton}
          >
            <RefreshCw size={14} /> Reload
          </button>
          <a href="/" style={secondaryButton}>
            <Home size={14} /> Home
          </a>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            border: "none", background: "transparent",
            color: "var(--gooni-muted, #8E8E93)", fontSize: 12,
            cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
            fontFamily: "inherit",
          }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? "Hide" : "Show"} technical detail
        </button>
        {open && (
          <pre style={{
            marginTop: 12, textAlign: "left",
            background: "rgba(0,0,0,0.04)",
            border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
            borderRadius: 8,
            padding: 12,
            fontSize: 11, lineHeight: 1.45,
            color: "#3A3A3C",
            overflow: "auto", maxHeight: 240,
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {message}
            {stack ? `\n\n${stack}` : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

export function NotFoundView() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "32px 24px",
      background: "var(--gooni-bg, #FAF7F0)",
      fontFamily: FONT,
    }}>
      <div style={{
        maxWidth: 420, width: "100%",
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 16,
        padding: "32px 28px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.06)",
        textAlign: "center",
      }}>
        <img
          src="/gooni-logo.svg"
          alt="Gooni"
          width={96} height={96}
          style={{ margin: "0 auto 16px", display: "block", opacity: 0.7 }}
        />
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: 1,
          color: "var(--gooni-muted, #8E8E93)", marginBottom: 6,
        }}>
          404
        </div>
        <h1 style={{
          margin: "0 0 6px",
          fontSize: 22, fontWeight: 600,
          color: "var(--gooni-text, #1C1C1E)",
        }}>
          Nothing here
        </h1>
        <p style={{
          margin: "0 0 22px",
          fontSize: 14, lineHeight: 1.5,
          color: "var(--gooni-muted, #6B7280)",
        }}>
          This URL doesn't match a note, list, or any other surface Gooni
          knows about. It might be an old link or a typo.
        </p>
        <a href="/" style={primaryButton}>
          <Home size={14} /> Back home
        </a>
      </div>
    </div>
  );
}

const primaryButton: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 16px", borderRadius: 8,
  border: "none",
  background: "var(--gooni-text, #1C1C1E)",
  color: "var(--gooni-card, #fff)",
  fontSize: 13, fontWeight: 500, cursor: "pointer",
  textDecoration: "none", fontFamily: FONT,
};

const secondaryButton: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 16px", borderRadius: 8,
  border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.15))",
  background: "var(--gooni-card, #fff)",
  color: "var(--gooni-text, #1C1C1E)",
  fontSize: 13, fontWeight: 500, cursor: "pointer",
  textDecoration: "none", fontFamily: FONT,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.toString();
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    try { return JSON.stringify(error, null, 2); } catch { /* fallthrough */ }
  }
  return "Unknown error";
}

function errorStack(error: unknown): string | null {
  if (error instanceof Error && error.stack) return error.stack;
  return null;
}
