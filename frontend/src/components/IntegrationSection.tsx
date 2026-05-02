import { useEffect, useState, type ReactNode } from "react";
import {
  fetchCalendarStatus, startCalendarOAuth, disconnectCalendar,
  fetchGithubStatus, startGithubOAuth, disconnectGithub,
} from "../services/api";

type Provider = "google" | "github";

interface ProviderApi {
  fetchStatus: () => Promise<Status>;
  start: () => Promise<{ authorize_url: string }>;
  disconnect: () => Promise<void>;
}

interface Status {
  configured: boolean;
  connected: boolean;
  account_email: string | null;
}

const PROVIDERS: Record<Provider, ProviderApi> = {
  google: {
    fetchStatus: fetchCalendarStatus,
    start: startCalendarOAuth,
    disconnect: disconnectCalendar,
  },
  github: {
    fetchStatus: fetchGithubStatus,
    start: startGithubOAuth,
    disconnect: disconnectGithub,
  },
};

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 9px", borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
  cursor: "pointer", color: "#1C1C1E", fontWeight: 500,
  fontFamily: "'Inter', -apple-system, sans-serif",
};

interface Props {
  provider: Provider;
  label: string;
  blurbConfigured: string;
  blurbNotConfigured: string;
  icon?: ReactNode;              // rendered before the label (e.g. provider logo)
  extras?: ReactNode;            // rendered below the button row when connected
  onStatusChange?: (s: Status) => void;
}

export function IntegrationSection({
  provider, label, blurbConfigured, blurbNotConfigured, icon, extras, onStatusChange,
}: Props) {
  const api = PROVIDERS[provider];
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.fetchStatus();
      setStatus(s);
      onStatusChange?.(s);
    } catch (e) {
      const fallback = { configured: false, connected: false, account_email: null };
      setStatus(fallback);
      setErr(String(e));
      onStatusChange?.(fallback);
    }
  }

  useEffect(() => { refresh(); }, [provider]);

  // Refresh on return from OAuth popup — callback posts a message.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e?.data?.type === "gooni-oauth-done") refresh();
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  async function connect() {
    setErr(null);
    setLoading(true);
    try {
      const { authorize_url } = await api.start();
      window.open(authorize_url, "gooni-oauth", "width=520,height=640");
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function disconnect() {
    setLoading(true);
    try {
      await api.disconnect();
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      border: "1px solid rgba(0,0,0,0.08)", borderRadius: 10,
      padding: "12px 14px", background: "#FDFCFA",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        {icon ? (
          <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{icon}</span>
        ) : (
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: status?.connected ? "#30D158" : (status?.configured ? "#C7C7CC" : "#FF9500"),
            flexShrink: 0,
          }} />
        )}
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1C1C1E" }}>{label}</span>
        <span style={{ fontSize: 11, color: "#8E8E93", marginLeft: "auto" }}>
          {!status
            ? "…"
            : !status.configured
            ? "backend env vars not set"
            : status.connected
            ? (status.account_email ?? "connected")
            : "not connected"}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: "#6B6B70", marginBottom: 10, lineHeight: 1.55 }}>
        {status?.configured ? blurbConfigured : blurbNotConfigured}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {status?.connected ? (
          <button onClick={disconnect} disabled={loading} style={btn}>disconnect</button>
        ) : (
          <button
            onClick={connect}
            disabled={loading || !status?.configured}
            style={{
              ...btn,
              background: status?.configured ? "#1C1C1E" : "#F2F2F2",
              color: status?.configured ? "#fff" : "#AEAEB2",
              border: status?.configured ? "none" : btn.border,
              cursor: status?.configured ? "pointer" : "default",
            }}
          >
            {loading ? "opening…" : "connect"}
          </button>
        )}
        {err && <span style={{ fontSize: 11, color: "#C44" }}>{err}</span>}
      </div>
      {status?.connected && extras ? (
        <div style={{ marginTop: 12 }}>{extras}</div>
      ) : null}
    </div>
  );
}
