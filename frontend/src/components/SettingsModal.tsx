import { useEffect, useRef, useState } from "react";
import pkg from "../../package.json";
import { GOONI_FACES, GOONI_FACE_LABELS, useGooniFaceStore, type GooniFace } from "../stores/useGooniFaceStore";
import { GOONI_THEMES, GOONI_THEME_LABELS, THEME_PALETTES, useGooniThemeStore, type GooniTheme } from "../stores/useGooniThemeStore";
import { useProfileStore } from "../stores/useProfileStore";
import { uploadAvatarImage, updatePublicAvatar } from "../services/api";
import { GooniFacePreview } from "./GooniMascot";
import { SettingsPanel } from "./SettingsPanel";
import { IntegrationSection } from "./IntegrationSection";
import { RepoPicker } from "./RepoPicker";
import { CommentAvatar } from "./notes/CommentAvatar";
import { FONT } from "../ui";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "profile" | "appearance" | "notifications" | "integrations" | "deployments";


const TABS: { id: Tab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "integrations", label: "Integrations" },
  { id: "deployments", label: "Deployments" },
];

// Single Settings modal for everything Daniel can configure. Replaces the
// old DevToolsModal — its content moved into the Integrations + Deployments
// tabs. Version sits in the header on every tab so Daniel never has to dig
// for "what version of Gooni am I running."
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<Tab>("profile");

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--gooni-card, #fff)",
          border: "0.5px solid rgba(0,0,0,0.1)",
          borderRadius: 14,
          width: 720,
          maxWidth: "calc(100vw - 32px)",
          height: 560,
          maxHeight: "calc(100vh - 80px)",
          display: "flex",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Tab sidebar */}
        <aside style={{
          width: 180, flexShrink: 0,
          background: "rgba(0,0,0,0.025)",
          borderRight: "0.5px solid rgba(0,0,0,0.08)",
          display: "flex", flexDirection: "column",
          padding: "16px 8px",
        }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: "var(--gooni-text, #1C1C1E)",
            padding: "0 10px 6px",
          }}>
            Settings
          </div>
          <div style={{
            fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
            padding: "0 10px 12px",
            fontFamily: "'SF Mono', Menlo, monospace",
          }}>
            v{pkg.version}
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    border: "none",
                    background: active ? "rgba(0,0,0,0.08)" : "transparent",
                    cursor: "pointer",
                    fontFamily: FONT,
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    color: "var(--gooni-text, #1C1C1E)",
                    padding: "8px 10px",
                    borderRadius: 6,
                    textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
                  onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content pane */}
        <div style={{
          flex: 1,
          padding: "20px 26px 22px",
          overflowY: "auto",
          position: "relative",
        }}>
          <button
            onClick={onClose}
            aria-label="Close settings"
            style={{
              position: "absolute",
              top: 10, right: 10,
              width: 26, height: 26,
              borderRadius: 6, border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--gooni-muted, #8E8E93)",
              fontSize: 16, lineHeight: 1,
            }}
          >×</button>

          {tab === "profile" && <ProfileTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "notifications" && <SettingsPanel />}
          {tab === "integrations" && <IntegrationsTab />}
          {tab === "deployments" && <DeploymentsTab />}
        </div>
      </div>
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────

function AppearanceTab() {
  const selectedFace = useGooniFaceStore((s) => s.face);
  const setFace = useGooniFaceStore((s) => s.setFace);
  const selectedTheme = useGooniThemeStore((s) => s.theme);
  const setTheme = useGooniThemeStore((s) => s.setTheme);

  return (
    <>
      <h2 style={{
        fontSize: 16, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        margin: 0, marginBottom: 18,
      }}>Appearance</h2>

      <section style={{ marginBottom: 22 }}>
        <SectionLabel>theme</SectionLabel>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {GOONI_THEMES.map((t: GooniTheme) => {
            const p = THEME_PALETTES[t];
            const selected = selectedTheme === t;
            return (
              <button
                key={t}
                onClick={() => setTheme(t)}
                title={GOONI_THEME_LABELS[t]}
                style={{
                  padding: 6, borderRadius: 10,
                  background: "transparent",
                  border: "none",
                  outline: selected ? "2px solid #4ADE80" : "1px solid rgba(0,0,0,0.08)",
                  outlineOffset: selected ? "-2px" : "-1px",
                  cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  transition: "outline-color 0.12s",
                }}
              >
                <div style={{
                  width: 48, height: 40, borderRadius: 6, overflow: "hidden",
                  display: "flex",
                  border: "0.5px solid rgba(0,0,0,0.08)",
                }}>
                  <div style={{ flex: 1, background: p.sidebar }} />
                  <div style={{ flex: 1, background: p.main }} />
                </div>
                <div style={{
                  fontSize: 10.5, color: selected ? "#1C1C1E" : "#8E8E93",
                  textTransform: "lowercase", letterSpacing: 0.2,
                  fontWeight: selected ? 600 : 400,
                }}>
                  {GOONI_THEME_LABELS[t]}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <SectionLabel>gooni's face</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
          {GOONI_FACES.map((f: GooniFace) => {
            const selected = selectedFace === f;
            return (
              <button
                key={f}
                onClick={() => setFace(f)}
                title={GOONI_FACE_LABELS[f]}
                style={{
                  padding: 6, borderRadius: 10,
                  background: selected ? "#fff" : "transparent",
                  border: "none",
                  outline: selected ? "2px solid #4ADE80" : "1px solid rgba(0,0,0,0.08)",
                  outlineOffset: selected ? "-2px" : "-1px",
                  cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  transition: "background 0.12s, outline-color 0.12s",
                }}
                onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.03)"; }}
                onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <GooniFacePreview face={f} size={36} />
                <div style={{
                  fontSize: 9.5, color: selected ? "#1C1C1E" : "#8E8E93",
                  textTransform: "lowercase", letterSpacing: 0.2, lineHeight: 1.1,
                  textAlign: "center", minHeight: 22, fontWeight: selected ? 600 : 400,
                }}>
                  {GOONI_FACE_LABELS[f]}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function ProfileTab() {
  const avatarUrl = useProfileStore((s) => s.avatarUrl);
  const fetchOnce = useProfileStore((s) => s.fetchOnce);
  const setAvatarUrl = useProfileStore((s) => s.setAvatarUrl);
  const refresh = useProfileStore((s) => s.refresh);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => { void fetchOnce(); }, [fetchOnce]);

  async function handleUpload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const { url } = await uploadAvatarImage(file);
      await updatePublicAvatar(url);
      setAvatarUrl(url);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1400);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "upload failed";
      setError(msg);
    } finally {
      setUploading(false);
    }
  }

  async function handleClear() {
    setError(null);
    try {
      await updatePublicAvatar(null);
      setAvatarUrl(null);
      // Re-fetch to confirm server state, in case anything else races.
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "reset failed");
    }
  }

  return (
    <>
      <h2 style={{
        fontSize: 16, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        margin: 0, marginBottom: 18,
      }}>Profile</h2>

      <section style={{ marginBottom: 22 }}>
        <SectionLabel>avatar</SectionLabel>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Preview = uploaded URL if present, else the owner initial tile
              (same renderer NoteComments uses as the fallback). */}
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="profile"
              style={{
                width: 72, height: 72, borderRadius: "50%",
                objectFit: "cover", flex: "none",
                boxShadow: "0 1px 3px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(0,0,0,0.06)",
              }}
            />
          ) : (
            <CommentAvatar identity={{ kind: "owner", display: "Daniel", initial: "D" }} avatarUrl={null} size={72} />
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                style={{
                  ...btn,
                  background: "#1C1C1E", color: "#fff",
                  cursor: uploading ? "default" : "pointer",
                  opacity: uploading ? 0.7 : 1,
                }}
              >
                {uploading ? "Uploading…" : avatarUrl ? "Replace photo" : "Upload photo"}
              </button>
              {avatarUrl && (
                <button
                  onClick={handleClear}
                  style={{
                    ...btn,
                    background: "transparent",
                    color: "#64748B",
                    border: "1px solid rgba(0,0,0,0.10)",
                  }}
                >
                  Reset to default
                </button>
              )}
            </div>
            <span style={{ fontSize: 11.5, color: "#94A3B8", fontFamily: FONT }}>
              {avatarUrl
                ? (savedFlash ? "✓ saved" : "PNG / JPG, up to 10 MB")
                : "Default avatar: your initial on a soft pastel tile."}
            </span>
            {error && (
              <span style={{ fontSize: 11.5, color: "#DC2626", fontFamily: FONT }}>
                {error}
              </span>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        </div>
      </section>
    </>
  );
}

function IntegrationsTab() {
  return (
    <>
      <h2 style={{
        fontSize: 16, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        margin: 0, marginBottom: 18,
      }}>Integrations</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <IntegrationSection
          provider="google"
          label="Google Calendar"
          icon={<GoogleCalendarLogo />}
          blurbConfigured="Connect to let Gooni create + edit calendar events from chat."
          blurbNotConfigured="Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI on the backend to enable."
        />
        <IntegrationSection
          provider="github"
          label="GitHub"
          icon={<GithubLogo />}
          blurbConfigured="Connect to surface today's commits, streak, and a weekly summary on the dashboard."
          blurbNotConfigured="Set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_REDIRECT_URI on the backend to enable."
          extras={<RepoPicker />}
        />
        <IntegrationSection
          provider="whoop"
          label="Whoop"
          icon={<WhoopLogo />}
          blurbConfigured="Connect to surface recovery, HRV, and sleep on the Stats view. Future: tune daily nudge based on recovery."
          blurbNotConfigured="Set WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET / WHOOP_REDIRECT_URI on the backend to enable."
        />
      </div>
    </>
  );
}

function DeploymentsTab() {
  return (
    <>
      <h2 style={{
        fontSize: 16, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        margin: 0, marginBottom: 6,
      }}>Deployments</h2>
      <div style={{ fontSize: 12, color: "var(--gooni-muted, #8E8E93)", marginBottom: 18 }}>
        Status, links, version. Pings use no-cors mode — green = host answered, not end-to-end healthy.
      </div>
      <DeploymentsBlock />
    </>
  );
}

// ── Bits moved out of DevToolsModal ──────────────────────────────────────

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
const env = import.meta.env as Record<string, string | undefined>;
const VERCEL_DEFAULT_URL = "https://gooni.vercel.app";
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

function withProtocol(host: string | undefined | null): string {
  if (!host) return "";
  if (host.startsWith("http://") || host.startsWith("https://")) return host.replace(/\/$/, "");
  return `https://${host}`.replace(/\/$/, "");
}
function detectVercelUrl(): string {
  const fromEnv = withProtocol(env.VITE_VERCEL_PROJECT_PRODUCTION_URL || env.VITE_VERCEL_URL);
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host.endsWith(".vercel.app") || host === "gooni.app") return window.location.origin.replace(/\/$/, "");
  }
  return localStorage.getItem(VERCEL_URL_KEY) || VERCEL_DEFAULT_URL;
}

interface FlyInfo {
  app?: string | null;
  machine_id?: string | null;
  machine_version?: string | null;
  region?: string | null;
  image_ref?: string | null;
  release_version?: string | null;
}

async function pingUrl(url: string): Promise<HealthState> {
  if (!url) return { status: "idle", latencyMs: null, error: "not configured", checkedAt: new Date() };
  const t0 = performance.now();
  try {
    await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" });
    return { status: "ok", latencyMs: Math.round(performance.now() - t0), error: null, checkedAt: new Date() };
  } catch (e) {
    return { status: "down", latencyMs: null, error: String(e), checkedAt: new Date() };
  }
}

function StatusDot({ status }: { status: HealthState["status"] }) {
  const color = status === "ok" ? "#30D158" : status === "down" ? "#FF3B30" : status === "checking" ? "#FFD60A" : "#C7C7CC";
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%", background: color,
      boxShadow: status === "checking" ? `0 0 6px ${color}` : "none",
      flexShrink: 0,
    }} />
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

function DeploymentsBlock() {
  const [flyState, setFlyState] = useState<HealthState>({ status: "idle", latencyMs: null, error: null, checkedAt: null });
  const [vercelState, setVercelState] = useState<HealthState>({ status: "idle", latencyMs: null, error: null, checkedAt: null });
  const [vercelUrl, setVercelUrl] = useState<string>(detectVercelUrl);
  const [editingVercel, setEditingVercel] = useState(false);
  const [vercelDraft, setVercelDraft] = useState("");
  const [flyInfo, setFlyInfo] = useState<FlyInfo | null>(null);

  async function checkFly() {
    setFlyState((s) => ({ ...s, status: "checking" }));
    setFlyState(await pingUrl(FLY_APP_URL));
    try {
      const r = await fetch(`${API_BASE}/health`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j?.fly) setFlyInfo(j.fly);
      }
    } catch { /* swallow */ }
  }
  async function checkVercel() {
    setVercelState((s) => ({ ...s, status: "checking" }));
    setVercelState(await pingUrl(vercelUrl));
  }

  useEffect(() => {
    checkFly();
    checkVercel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveVercelUrl() {
    const cleaned = vercelDraft.trim().replace(/\/$/, "");
    localStorage.setItem(VERCEL_URL_KEY, cleaned);
    setVercelUrl(cleaned);
    setEditingVercel(false);
    setTimeout(() => {
      setVercelState((s) => ({ ...s, status: "checking" }));
      pingUrl(cleaned).then(setVercelState);
    }, 0);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <DeploymentCard
        name="Fly.io — gooni-bot"
        url={FLY_APP_URL}
        dashboardUrl={FLY_DASHBOARD}
        state={flyState}
        onRecheck={checkFly}
        meta={flyMeta(flyInfo)}
      />
      {editingVercel ? (
        <div style={{ border: "1px solid rgba(0,0,0,0.1)", borderRadius: 10, padding: 12, background: "#FDFCFA" }}>
          <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 6 }}>Vercel deployment URL</div>
          <input
            value={vercelDraft}
            onChange={(e) => setVercelDraft(e.target.value)}
            autoFocus
            placeholder="https://your-app.vercel.app"
            style={{
              width: "100%", padding: "6px 8px", borderRadius: 6,
              border: "1px solid rgba(0,0,0,0.1)",
              fontSize: 12.5, fontFamily: "'SF Mono', Menlo, monospace",
              outline: "none", boxSizing: "border-box", marginBottom: 8,
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveVercelUrl();
              if (e.key === "Escape") setEditingVercel(false);
            }}
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
          meta={vercelMeta()}
        />
      )}
    </div>
  );
}

interface DeploymentCardProps {
  name: string;
  url: string;
  dashboardUrl: string;
  state: HealthState;
  onRecheck: () => void;
  onEditUrl?: () => void;
  meta?: { label: string; value: string; href?: string }[];
}

function DeploymentCard({ name, url, dashboardUrl, state, onRecheck, onEditUrl, meta }: DeploymentCardProps) {
  useNow(1000);
  return (
    <div style={{
      border: "1px solid rgba(0,0,0,0.08)", borderRadius: 10,
      padding: "12px 14px", background: "#FDFCFA",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StatusDot status={state.status} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#1C1C1E" }}>{name}</span>
        <span style={{ fontSize: 11, color: "#8E8E93", marginLeft: "auto" }}>
          {state.status === "ok" && state.latencyMs != null
            ? `${state.latencyMs} ms`
            : state.status === "down" ? "unreachable"
            : state.status === "checking" ? "checking…"
            : "—"}
        </span>
      </div>
      <div style={{
        fontSize: 11.5, color: "#6B6B70",
        fontFamily: "'SF Mono', Menlo, monospace",
        marginBottom: 4, wordBreak: "break-all",
      }}>
        {url || "(not configured)"}
      </div>
      <div style={{ fontSize: 10.5, color: "#AEAEB2", marginBottom: meta && meta.length ? 8 : 10 }}>
        {state.checkedAt ? `last checked ${formatRelativeTime(state.checkedAt)}` : "never checked"}
      </div>
      {meta && meta.length > 0 && (
        <div style={{
          display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px",
          fontSize: 10.5, marginBottom: 10,
        }}>
          {meta.map((m) => (
            <div key={m.label} style={{ display: "contents" }}>
              <span style={{
                color: "#AEAEB2", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600,
              }}>
                {m.label}
              </span>
              {m.href ? (
                <a href={m.href} target="_blank" rel="noreferrer" style={{
                  color: "#1C1C1E", fontFamily: "'SF Mono', Menlo, monospace",
                  textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>{m.value}</a>
              ) : (
                <span style={{
                  color: "#1C1C1E", fontFamily: "'SF Mono', Menlo, monospace",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{m.value}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button onClick={onRecheck} style={btn}>recheck</button>
        {url && <a href={url} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>open app</a>}
        <a href={dashboardUrl} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: "none" }}>dashboard</a>
        {onEditUrl && <button onClick={onEditUrl} style={btn}>edit url</button>}
      </div>
    </div>
  );
}

function flyMeta(info: FlyInfo | null): { label: string; value: string }[] {
  if (!info) return [];
  const out: { label: string; value: string }[] = [];
  if (info.region) out.push({ label: "region", value: info.region });
  if (info.machine_version) out.push({ label: "version", value: info.machine_version });
  if (info.image_ref) out.push({ label: "image", value: info.image_ref.split(":").pop() ?? info.image_ref });
  if (info.machine_id) out.push({ label: "machine", value: info.machine_id });
  return out;
}

function vercelMeta(): { label: string; value: string; href?: string }[] {
  const out: { label: string; value: string; href?: string }[] = [];
  const sha = env.VITE_VERCEL_GIT_COMMIT_SHA;
  const ref = env.VITE_VERCEL_GIT_COMMIT_REF;
  const dep = env.VITE_VERCEL_DEPLOYMENT_ID;
  const venv = env.VITE_VERCEL_ENV;
  if (venv) out.push({ label: "env", value: venv });
  if (ref) out.push({ label: "branch", value: ref });
  if (sha) out.push({
    label: "commit", value: sha.slice(0, 7),
    href: `https://github.com/gub1th/gooni/commit/${sha}`,
  });
  if (dep) out.push({ label: "deploy", value: dep });
  return out;
}

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 9px", borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
  cursor: "pointer", color: "#1C1C1E", fontWeight: 500,
  fontFamily: FONT,
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: "var(--gooni-muted, #8E8E93)",
      letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 12,
    }}>
      {children}
    </div>
  );
}

// ── Real provider logos ─────────────────────────────────────────────────

function GoogleCalendarLogo() {
  // Simplified Google Calendar mark: rounded white square with a blue '31'
  // and the four-color top bar. Inline SVG so we don't add a binary asset.
  return (
    <svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="6" y="9" width="36" height="33" rx="4" fill="#fff" stroke="#dadce0" strokeWidth="1" />
      <rect x="6" y="9" width="36" height="6" rx="4" fill="#1a73e8" />
      <text x="24" y="34" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif"
        fontWeight="700" fontSize="14" fill="#1a73e8">31</text>
      <circle cx="14" cy="6" r="1.6" fill="#5f6368" />
      <circle cx="34" cy="6" r="1.6" fill="#5f6368" />
      <line x1="14" y1="6" x2="14" y2="11" stroke="#5f6368" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="34" y1="6" x2="34" y2="11" stroke="#5f6368" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function GithubLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="#1C1C1E" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.07c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.69.08-.69 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.41-5.27 5.7.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z"/>
    </svg>
  );
}

function WhoopLogo() {
  // Whoop's brand mark is a wordmark — we'd rather not redistribute it
  // verbatim. Stand-in: a black rounded square with a stylized heart-rate
  // pulse line in white. Reads as "biometrics" without scraping the logo.
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect width="24" height="24" rx="6" fill="#0F0F10" />
      <path
        d="M3 13 L7 13 L9 8 L11 17 L13 11 L15 14 L21 14"
        stroke="#FFFFFF"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

