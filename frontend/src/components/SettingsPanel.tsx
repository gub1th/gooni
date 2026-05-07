import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, RotateCcw } from "lucide-react";
import {
  fetchSettings,
  fetchNudgePromptDefault,
  updateSettings,
  testNudge,
  type AppSettings,
  type NudgeChannel,
  type NudgeTestResult,
} from "../services/api";
import { Skeleton } from "./Skeleton";

// Subset of IANA zones — covers the time zones a single-tenant Gooni user is
// realistically in. Add more if needed; the backend validates against zoneinfo.
const TZ_OPTIONS = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

export function SettingsPanel() {
  const qc = useQueryClient();
  const { data: settings, isLoading, error } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });

  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<NudgeTestResult | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  // Local copy of the prompt textarea so typing feels instant. Only PATCHed
  // on blur or after a debounce — no per-keystroke fetch.
  const [promptDraft, setPromptDraft] = useState("");
  const promptDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedPrompt = useRef<string>("");

  // Hydrate the textarea when settings first load (and only then — typing
  // should never be clobbered by a re-fetch from updateSettings).
  useEffect(() => {
    if (settings && lastSavedPrompt.current === "" && settings.nudge_prompt !== promptDraft) {
      setPromptDraft(settings.nudge_prompt || "");
      lastSavedPrompt.current = settings.nudge_prompt || "";
    }
  }, [settings, promptDraft]);

  async function patch(p: Partial<AppSettings>) {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await updateSettings(p);
      qc.setQueryData(["settings"], next);
      if (p.nudge_prompt !== undefined) {
        lastSavedPrompt.current = next.nudge_prompt || "";
      }
    } catch (e) {
      console.error("settings patch failed", e);
    } finally {
      setSaving(false);
    }
  }

  function toggleChannel(c: NudgeChannel) {
    if (!settings) return;
    const has = settings.nudge_channels.includes(c);
    const next = has
      ? settings.nudge_channels.filter((x) => x !== c)
      : [...settings.nudge_channels, c];
    void patch({ nudge_channels: next });
  }

  function onPromptChange(v: string) {
    setPromptDraft(v);
    if (promptDebounce.current) clearTimeout(promptDebounce.current);
    promptDebounce.current = setTimeout(() => {
      if (v !== lastSavedPrompt.current) void patch({ nudge_prompt: v });
    }, 800);
  }

  async function fillDefaultPrompt() {
    try {
      const def = await fetchNudgePromptDefault();
      setPromptDraft(def);
      void patch({ nudge_prompt: def });
    } catch (e) {
      console.error("fetch default prompt failed", e);
    }
  }

  async function runTest() {
    setTestRunning(true);
    setTestResult(null);
    try {
      const r = await testNudge();
      setTestResult(r);
    } catch (e) {
      setTestResult({ sent: false, reason: String(e) });
    } finally {
      setTestRunning(false);
    }
  }

  return (
    <section>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: "var(--gooni-muted, #8E8E93)",
          letterSpacing: 0.6, textTransform: "uppercase",
        }}>
          daily digest
        </div>
        {saving && (
          <span style={{
            marginLeft: "auto", fontSize: 11,
            color: "var(--gooni-muted, #8E8E93)",
          }}>
            saving…
          </span>
        )}
      </div>

      {isLoading && <Skeleton style={{ height: 200 }} />}
      {error && (
        <p style={{ fontSize: 12, color: "#C44" }}>
          Couldn't load settings: {String(error)}
        </p>
      )}

      {settings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Enabled toggle */}
          <Row label="Enabled">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.nudge_enabled}
                onChange={(e) => patch({ nudge_enabled: e.target.checked })}
              />
              <span style={{ fontSize: 13, color: "var(--gooni-text, #1C1C1E)" }}>
                send a daily message
              </span>
            </label>
          </Row>

          {/* Time + tz */}
          <Row label="Time">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="time"
                value={`${pad(settings.nudge_hour)}:${pad(settings.nudge_minute)}`}
                onChange={(e) => {
                  const [hh, mm] = e.target.value.split(":");
                  void patch({
                    nudge_hour: parseInt(hh, 10),
                    nudge_minute: parseInt(mm, 10),
                  });
                }}
                style={inputStyle}
              />
              <select
                value={settings.nudge_tz}
                onChange={(e) => patch({ nudge_tz: e.target.value })}
                style={{ ...inputStyle, padding: "5px 8px" }}
              >
                {TZ_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
                {/* Surface the current value if it's not in the canned list,
                    so a manually-set zone doesn't silently revert. */}
                {!TZ_OPTIONS.includes(settings.nudge_tz) && (
                  <option value={settings.nudge_tz}>{settings.nudge_tz}</option>
                )}
              </select>
            </div>
          </Row>

          {/* Channels */}
          <Row label="Channels">
            <div style={{ display: "flex", gap: 14 }}>
              {(["telegram", "whatsapp"] as NudgeChannel[]).map((c) => (
                <label
                  key={c}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, fontSize: 13,
                    color: "var(--gooni-text, #1C1C1E)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={settings.nudge_channels.includes(c)}
                    onChange={() => toggleChannel(c)}
                  />
                  <span style={{ textTransform: "capitalize" }}>{c}</span>
                </label>
              ))}
            </div>
          </Row>

          {/* WhatsApp 24h-window note */}
          {settings.nudge_channels.includes("whatsapp") && (
            <p style={{
              margin: 0, fontSize: 11, color: "var(--gooni-muted, #8E8E93)", lineHeight: 1.5,
              padding: "8px 10px",
              background: "var(--gooni-bg, #FAFAFA)",
              borderRadius: 8,
              border: "0.5px dashed var(--gooni-border, rgba(0,0,0,0.08))",
            }}>
              <strong>WhatsApp note:</strong> Meta only allows the bot to send
              you messages within 24h of your last DM to it. If you've been
              quiet on WA, the morning message will skip until you say hi to Gooni.
            </p>
          )}

          {/* User-editable digest prompt */}
          <Row label="Prompt" align="start">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <textarea
                value={promptDraft}
                onChange={(e) => onPromptChange(e.target.value)}
                onBlur={() => {
                  if (promptDraft !== lastSavedPrompt.current) {
                    if (promptDebounce.current) clearTimeout(promptDebounce.current);
                    void patch({ nudge_prompt: promptDraft });
                  }
                }}
                placeholder="Write the instruction Gooni follows to compose your morning message…"
                rows={6}
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "8px 10px",
                  border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
                  borderRadius: 8,
                  fontSize: 12.5, lineHeight: 1.5,
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                  color: "var(--gooni-text, #1C1C1E)",
                  background: "var(--gooni-card, #FFF)",
                  resize: "vertical",
                  minHeight: 90,
                  outline: "none",
                }}
              />
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
              }}>
                <span>
                  Empty = use Gooni's bundled default. Daniel's todos &amp; focuses are
                  injected after the prompt.
                </span>
                <button
                  onClick={fillDefaultPrompt}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 8px", borderRadius: 6,
                    background: "transparent",
                    color: "var(--gooni-text, #1C1C1E)",
                    border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
                    fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                  }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
                >
                  <RotateCcw size={11} />
                  Use default
                </button>
              </div>
            </div>
          </Row>

          {/* Test send */}
          <div
            style={{
              display: "flex", alignItems: "center", gap: 10,
              paddingTop: 10,
              borderTop: "0.5px solid var(--gooni-border, rgba(0,0,0,0.06))",
            }}
          >
            <button
              onClick={runTest}
              disabled={testRunning}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 11px",
                background: testRunning ? "var(--gooni-bg, #E4E4E7)" : "var(--gooni-text, #1C1C1E)",
                color: testRunning ? "var(--gooni-muted, #8E8E93)" : "var(--gooni-card, #FFF)",
                border: "none", borderRadius: 8,
                fontSize: 12, fontWeight: 600, cursor: testRunning ? "wait" : "pointer",
                fontFamily: "inherit",
              }}
            >
              <Send size={12} />
              {testRunning ? "sending…" : "Send test now"}
            </button>
            {testResult && (
              <span style={{ fontSize: 12, color: testResult.sent ? "#30A14E" : "var(--gooni-muted, #8E8E93)" }}>
                {testResult.sent
                  ? `sent → ${(testResult.to ?? []).join(", ")}`
                  : `not sent · ${testResult.reason ?? "no recipients"}`}
                {testResult.skipped && testResult.skipped.length > 0 && (
                  <span style={{ color: "var(--gooni-muted, #A0A0A5)" }}>
                    {" "}(skipped: {testResult.skipped.join(", ")})
                  </span>
                )}
              </span>
            )}
          </div>

          {settings.nudge_last_sent_day && (
            <p style={{ margin: 0, fontSize: 11, color: "var(--gooni-muted, #A0A0A5)" }}>
              last fired: {settings.nudge_last_sent_day}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: align === "start" ? "flex-start" : "center",
      gap: 18,
    }}>
      <span style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)", fontWeight: 600,
        textTransform: "uppercase", letterSpacing: 0.4,
        width: 84, flexShrink: 0,
        paddingTop: align === "start" ? 8 : 0,
      }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
  color: "var(--gooni-text, #1C1C1E)",
  background: "var(--gooni-card, #FFF)",
};
