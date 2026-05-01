import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings as SettingsIcon, Send } from "lucide-react";
import {
  fetchSettings,
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

  async function patch(p: Partial<AppSettings>) {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await updateSettings(p);
      qc.setQueryData(["settings"], next);
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
        display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: "var(--gooni-muted, #8E8E93)",
          letterSpacing: 0.6, textTransform: "uppercase",
        }}>
          daily nudge
        </div>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
          {saving && (
            <span style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
              saving…
            </span>
          )}
          <SettingsIcon size={12} color="#C7C7CC" />
        </span>
      </div>

      {isLoading && <Skeleton style={{ height: 120 }} />}
      {error && (
        <p style={{ fontSize: 12, color: "#C44" }}>
          Couldn't load settings: {String(error)}
        </p>
      )}

      {settings && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Enabled toggle */}
          <Row label="Enabled">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.nudge_enabled}
                onChange={(e) => patch({ nudge_enabled: e.target.checked })}
              />
              <span style={{ fontSize: 13, color: "var(--gooni-text, #1C1C1E)" }}>
                send a daily digest
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
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}
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
              padding: "8px 10px", background: "#FAFAFA", borderRadius: 8,
              border: "0.5px dashed rgba(0,0,0,0.08)",
            }}>
              <strong>WhatsApp note:</strong> Meta only allows the bot to send
              you messages within 24h of your last DM to it. If you've been
              quiet on WA, the morning nudge will skip until you say hi to Gooni.
            </p>
          )}

          {/* Test send */}
          <div
            style={{
              display: "flex", alignItems: "center", gap: 10,
              paddingTop: 8, borderTop: "0.5px solid rgba(0,0,0,0.06)",
            }}
          >
            <button
              onClick={runTest}
              disabled={testRunning}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 11px",
                background: testRunning ? "#E4E4E7" : "#1C1C1E",
                color: testRunning ? "#8E8E93" : "#FFF",
                border: "none", borderRadius: 8,
                fontSize: 12, fontWeight: 600, cursor: testRunning ? "wait" : "pointer",
              }}
            >
              <Send size={12} />
              {testRunning ? "sending…" : "Send test now"}
            </button>
            {testResult && (
              <span style={{ fontSize: 12, color: testResult.sent ? "#30A14E" : "#8E8E93" }}>
                {testResult.sent
                  ? `sent → ${(testResult.to ?? []).join(", ")}`
                  : `not sent · ${testResult.reason ?? "no recipients"}`}
                {testResult.skipped && testResult.skipped.length > 0 && (
                  <span style={{ color: "#A0A0A5" }}>
                    {" "}(skipped: {testResult.skipped.join(", ")})
                  </span>
                )}
              </span>
            )}
          </div>

          {settings.nudge_last_sent_day && (
            <p style={{ margin: 0, fontSize: 11, color: "#A0A0A5" }}>
              last fired: {settings.nudge_last_sent_day}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
      <span style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)", fontWeight: 600,
        textTransform: "uppercase", letterSpacing: 0.4,
        width: 84, flexShrink: 0,
      }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const inputStyle: React.CSSProperties = {
  padding: "5px 8px",
  border: "0.5px solid rgba(0,0,0,0.12)",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "inherit",
  color: "var(--gooni-text, #1C1C1E)",
  background: "#FFF",
};
