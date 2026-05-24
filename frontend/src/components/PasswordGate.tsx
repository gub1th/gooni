import { useState } from "react";
import { getStoredToken, login } from "../services/api";
import { GooniLogo } from "./GooniLogo";
import { FONT } from "../ui";

interface Props {
  children: React.ReactNode;
}

const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

export function PasswordGate({ children }: Props) {
  const [authed, setAuthed] = useState(() => !!getStoredToken());
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);

  if (authed) return <>{children}</>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(password);
      setAuthed(true);
    } catch {
      setError("Wrong password");
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = password.length > 0 && !loading;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        // Match the /public warm gradient — almost-invisible mint at the
        // top, cream → white below. Keeps the gate visually continuous
        // with the rest of the app rather than a separate dark world.
        background:
          "radial-gradient(ellipse 1100px 600px at 50% -10%, rgba(74,222,128,0.08), transparent 70%), linear-gradient(180deg, #fbfaf7 0%, #ffffff 45%)",
        fontFamily: FONT,
        color: "#111",
        padding: 24,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 14,
          width: 320,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            marginBottom: 14,
          }}
        >
          <GooniLogo size={56} style={{ borderRadius: 14, boxShadow: "0 8px 22px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)" }} />
          <div
            style={{
              fontFamily: DISPLAY,
              fontSize: 26,
              fontWeight: 500,
              letterSpacing: "-0.4px",
              color: "#111",
            }}
          >
            welcome back
          </div>
          <div style={{ fontSize: 13, color: "#8a8a8a", marginTop: -6 }}>
            sign in to gooni
          </div>
        </div>

        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoFocus
          autoComplete="current-password"
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: `1px solid ${focused ? "#9FE1CB" : "rgba(0,0,0,0.10)"}`,
            background: "#ffffff",
            color: "#111",
            fontSize: 14.5,
            fontFamily: FONT,
            outline: "none",
            boxShadow: focused
              ? "0 0 0 3px rgba(159,225,203,0.30), 0 1px 2px rgba(0,0,0,0.03)"
              : "0 1px 2px rgba(0,0,0,0.03)",
            transition: "border-color 160ms ease, box-shadow 160ms ease",
          }}
        />

        {error && (
          <div
            role="alert"
            style={{
              fontSize: 12.5,
              color: "#B91C1C",
              background: "rgba(220,38,38,0.06)",
              border: "1px solid rgba(220,38,38,0.18)",
              borderRadius: 10,
              padding: "8px 12px",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "none",
            background: canSubmit ? "#111" : "#e7e7e7",
            color: canSubmit ? "#fff" : "#aaa",
            fontSize: 14,
            fontWeight: 500,
            fontFamily: FONT,
            letterSpacing: "0.01em",
            cursor: canSubmit ? "pointer" : "not-allowed",
            transition: "transform 120ms ease, background 160ms ease, box-shadow 160ms ease",
            boxShadow: canSubmit ? "0 4px 12px rgba(0,0,0,0.10)" : "none",
          }}
          onMouseEnter={(e) => {
            if (!canSubmit) return;
            (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 8px 18px rgba(0,0,0,0.14)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow = canSubmit
              ? "0 4px 12px rgba(0,0,0,0.10)"
              : "none";
          }}
        >
          {loading ? "signing in…" : "enter"}
        </button>

        <div
          style={{
            marginTop: 6,
            fontSize: 11.5,
            color: "#b5b5b5",
            textAlign: "center",
            letterSpacing: "0.02em",
          }}
        >
          private — daniel's personal notebook
        </div>
      </form>
    </div>
  );
}
