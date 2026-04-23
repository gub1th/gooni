import { useEffect, useState } from "react";
import pkg from "../../package.json";

interface DevToolsModalProps {
  open: boolean;
  onClose: () => void;
}

interface HealthState {
  status: "idle" | "checking" | "ok" | "down";
  latencyMs: number | null;
  error: string | null;
  checkedAt: Date | null;
}

const FLY_APP_URL = "https://gooni-bot.fly.dev";
const FLY_DASHBOARD = "https://fly.io/apps/gooni-bot";
const VERCEL_DASHBOARD = "https://vercel.com/daniels-projects-eac22a07/gooni";
const VERCEL_URL_KEY = "gooni_vercel_url";

async function pingUrl(url: string): Promise<HealthState> {
  if (!url) return { status: "idle", latencyMs: null, error: "not configured", checkedAt: new Date() };
  const t0 = performance.now();
  try {
    // no-cors so CORS won't kill a liveness ping; we only care that the host responds.
    await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" });
    return { status: "ok", latencyMs: Math.round(performance.now() - t0), error: null, checkedAt: new Date() };
  } catch (e) {
    return { status: "down", latencyMs: null, error: String(e), checkedAt: new Date() };
  }
}

function StatusDot({ status }: { status: HealthState["status"] }) {
  const color = status === "ok" ? "#30D158" : status === "down" ? "#FF3B30" : status === "checking" ? "#FFD60A" : "#C7C7CC";
  return (
    <span
      style={{
        width: 8, height: 8, borderRadius: "50%", background: color,
        boxShadow: status === "checking" ? `0 0 6px ${color}` : "none",
        flexShrink: 0,
      }}
    />
  );
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return date.toLocaleDateString();
}

function useNow(intervalMs = 15000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface DeploymentCardProps {
  name: string;
  url: string;
  dashboardUrl: string;
  state: HealthState;
  onRecheck: () => void;
  onEditUrl?: () => void;
}

function DeploymentCard({ name, url, dashboardUrl, state, onRecheck, onEditUrl }: DeploymentCardProps) {
  // tick once a second so "last checked Xs ago" stays fresh while the modal is open
  useNow(1000);
  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 10,
        padding: "12px 14px",
        background: "#FDFCFA",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StatusDot status={state.status} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1C1C1E" }}>{name}</span>
        <span style={{ fontSize: 11, color: "#8E8E93", marginLeft: "auto" }}>
          {state.status === "ok" && state.latencyMs != null ? `${state.latencyMs} ms` : state.status === "down" ? "unreachable" : state.status === "checking" ? "checking…" : "—"}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: "#6B6B70", fontFamily: "'SF Mono', Menlo, monospace", marginBottom: 4, wordBreak: "break-all" }}>
        {url || "(not configured)"}
      </div>
      <div style={{ fontSize: 10.5, color: "#AEAEB2", marginBottom: 10 }}>
        {state.checkedAt ? `last checked ${formatRelativeTime(state.checkedAt)}` : "never checked"}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={onRecheck}
          style={btn}
        >recheck</button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>open app</a>
        )}
        <a href={dashboardUrl} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>dashboard</a>
        {onEditUrl && (
          <button onClick={onEditUrl} style={btn}>edit url</button>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 9px", borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
  cursor: "pointer", color: "#1C1C1E", fontWeight: 500,
  fontFamily: "'Manrope', -apple-system, sans-serif",
};

export function DevToolsModal({ open, onClose }: DevToolsModalProps) {
  const [flyState, setFlyState] = useState<HealthState>({ status: "idle", latencyMs: null, error: null, checkedAt: null });
  const [vercelState, setVercelState] = useState<HealthState>({ status: "idle", latencyMs: null, error: null, checkedAt: null });
  const [vercelUrl, setVercelUrl] = useState<string>(() => localStorage.getItem(VERCEL_URL_KEY) ?? "");
  const [editingVercel, setEditingVercel] = useState(false);
  const [vercelDraft, setVercelDraft] = useState("");

  async function checkFly() {
    setFlyState((s) => ({ ...s, status: "checking" }));
    setFlyState(await pingUrl(FLY_APP_URL));
  }
  async function checkVercel() {
    setVercelState((s) => ({ ...s, status: "checking" }));
    setVercelState(await pingUrl(vercelUrl));
  }

  useEffect(() => {
    if (!open) return;
    checkFly();
    checkVercel();
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  function saveVercelUrl() {
    const cleaned = vercelDraft.trim().replace(/\/$/, "");
    localStorage.setItem(VERCEL_URL_KEY, cleaned);
    setVercelUrl(cleaned);
    setEditingVercel(false);
    // re-ping with new URL
    setTimeout(() => {
      setVercelState((s) => ({ ...s, status: "checking" }));
      pingUrl(cleaned).then(setVercelState);
    }, 0);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 200,
        fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          border: "0.5px solid rgba(0,0,0,0.1)",
          borderRadius: 14,
          padding: "22px 24px 24px",
          width: 460,
          maxWidth: "calc(100vw - 32px)",
          position: "relative",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close dev tools"
          style={{
            position: "absolute", top: 10, right: 10, width: 28, height: 28,
            borderRadius: 6, border: "none", background: "transparent",
            cursor: "pointer", color: "#8E8E93", fontSize: 18, lineHeight: 1,
          }}
        >×</button>

        <div style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", marginBottom: 4 }}>
          Dev tools
        </div>
        <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 18 }}>
          Local-only panel. Status, links, version.
        </div>

        {/* Version */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(0,0,0,0.06)", marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>Gooni version</span>
          <span style={{ fontSize: 13, fontFamily: "'SF Mono', Menlo, monospace", color: "#1C1C1E" }}>
            v{pkg.version}
          </span>
        </div>

        {/* Deployments */}
        <div style={{ fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>
          Deployments
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <DeploymentCard
            name="Fly.io — gooni-bot"
            url={FLY_APP_URL}
            dashboardUrl={FLY_DASHBOARD}
            state={flyState}
            onRecheck={checkFly}
          />
          {editingVercel ? (
            <div style={{ border: "1px solid rgba(0,0,0,0.1)", borderRadius: 10, padding: 12, background: "#FDFCFA" }}>
              <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 6 }}>Vercel deployment URL</div>
              <input
                value={vercelDraft}
                onChange={(e) => setVercelDraft(e.target.value)}
                autoFocus
                placeholder="https://your-app.vercel.app"
                style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.1)", fontSize: 12.5, fontFamily: "'SF Mono', Menlo, monospace", outline: "none", boxSizing: "border-box", marginBottom: 8 }}
                onKeyDown={(e) => { if (e.key === "Enter") saveVercelUrl(); if (e.key === "Escape") setEditingVercel(false); }}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={saveVercelUrl} style={{ ...btn, background: "#1C1C1E", color: "#fff", border: "none" }}>save</button>
                <button onClick={() => setEditingVercel(false)} style={btn}>cancel</button>
              </div>
            </div>
          ) : (
            <DeploymentCard
              name="Vercel"
              url={vercelUrl}
              dashboardUrl={VERCEL_DASHBOARD}
              state={vercelState}
              onRecheck={checkVercel}
              onEditUrl={() => { setVercelDraft(vercelUrl); setEditingVercel(true); }}
            />
          )}
        </div>

        <div style={{ marginTop: 16, fontSize: 11, color: "#AEAEB2", lineHeight: 1.5 }}>
          Pings use <code>fetch(&hellip;, {`{mode: "no-cors"}`})</code> so any response counts as "reachable." A green dot means the host answered, not that the app is healthy end-to-end.
        </div>
      </div>
    </div>
  );
}
