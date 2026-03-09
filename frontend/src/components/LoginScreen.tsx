import { useState } from "react";

interface LoginScreenProps {
  onLogin: (password: string) => boolean;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (onLogin(password)) {
      setError("");
    } else {
      setError("Incorrect password");
      setPassword("");
    }
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
      }}
    >
      <div
        style={{
          background: "white",
          padding: "40px",
          borderRadius: "12px",
          boxShadow: "0 20px 40px rgba(0,0,0,0.1)",
          textAlign: "center",
          width: "320px",
        }}
      >
        <h1 style={{ margin: "0 0 8px 0", fontSize: "28px", fontWeight: 700, color: "#1C1C1E" }}>
          Gooni
        </h1>
        <p style={{ margin: "0 0 24px 0", fontSize: "14px", color: "#8E8E93" }}>
          Enter password to continue
        </p>
        
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            style={{
              width: "100%",
              padding: "12px",
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: "8px",
              fontSize: "16px",
              boxSizing: "border-box",
              marginBottom: error ? "8px" : "16px",
              outline: "none",
            }}
          />
          
          {error && (
            <div style={{ color: "#FF3B30", fontSize: "14px", marginBottom: "16px" }}>
              {error}
            </div>
          )}
          
          <button
            type="submit"
            style={{
              width: "100%",
              padding: "12px",
              background: "#007AFF",
              color: "white",
              border: "none",
              borderRadius: "8px",
              fontSize: "16px",
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.2s",
            }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#0056CC")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#007AFF")}
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}
