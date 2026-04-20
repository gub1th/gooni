import { useState } from "react";
import { getStoredToken, login } from "../services/api";

interface Props {
  children: React.ReactNode;
}

export function PasswordGate({ children }: Props) {
  const [authed, setAuthed] = useState(() => !!getStoredToken());
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        backgroundColor: "#0f0f0f",
        fontFamily: "inherit",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: 280,
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 600, color: "#f0f0f0", marginBottom: 4 }}>
          gooni
        </div>
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #2a2a2a",
            backgroundColor: "#1a1a1a",
            color: "#f0f0f0",
            fontSize: 14,
            outline: "none",
          }}
        />
        {error && <div style={{ fontSize: 12, color: "#e05a5a" }}>{error}</div>}
        <button
          type="submit"
          disabled={loading || !password}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "none",
            backgroundColor: "#2a2a2a",
            color: "#f0f0f0",
            fontSize: 14,
            cursor: loading || !password ? "not-allowed" : "pointer",
            opacity: loading || !password ? 0.5 : 1,
          }}
        >
          {loading ? "..." : "Enter"}
        </button>
      </form>
    </div>
  );
}
