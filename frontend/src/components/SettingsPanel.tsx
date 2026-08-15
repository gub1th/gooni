import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchSettings,
  updateSettings,
  type AppSettings,
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

// Two knobs: the app-wide canonical timezone (`nudge_tz`, legacy column name
// from the nudge system the 2026-07 proactiveness reset deleted — everything
// user-facing that resolves "today" reads it), and the proactive layer's kill
// switch. The second one lives here rather than in env because it is the knob
// you want to reach in seconds from the UI when the loop starts saying
// something stupid; GOONI_PROACTIVE_DISABLED still overrides it for a prod stop
// that must not need a database write.
export function SettingsPanel() {
  const qc = useQueryClient();
  const { data: settings, isLoading, error } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });
  const [saving, setSaving] = useState(false);

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

  return (
    <section>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: "var(--gooni-muted, #8E8E93)",
          letterSpacing: 0.6, textTransform: "uppercase",
        }}>
          general
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

      {isLoading && <Skeleton style={{ height: 60 }} />}
      {error && (
        <p style={{ fontSize: 12, color: "#C44" }}>
          Couldn't load settings: {String(error)}
        </p>
      )}

      {settings && (
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 18 }}>
          <span style={{
            fontSize: 11, color: "var(--gooni-muted, #8E8E93)", fontWeight: 600,
            textTransform: "uppercase", letterSpacing: 0.4,
            width: 84, flexShrink: 0,
          }}>Timezone</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <select
              value={settings.nudge_tz}
              onChange={(e) => patch({ nudge_tz: e.target.value })}
              style={{
                padding: "5px 8px",
                border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
                borderRadius: 6,
                fontSize: 13,
                fontFamily: "inherit",
                color: "var(--gooni-text, #1C1C1E)",
                background: "var(--gooni-card, #FFF)",
              }}
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
            <p style={{
              margin: "6px 0 0", fontSize: 11,
              color: "var(--gooni-muted, #A0A0A5)", lineHeight: 1.5,
            }}>
              Gooni's canonical timezone — "today" everywhere (trackables,
              promises, chat) resolves against it.
            </p>
          </div>
        </div>
      )}

      {settings && (
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <span style={{
            fontSize: 11, color: "var(--gooni-muted, #8E8E93)", fontWeight: 600,
            textTransform: "uppercase", letterSpacing: 0.4,
            width: 84, flexShrink: 0,
          }}>Proactive</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 13,
              color: "var(--gooni-text, #1C1C1E)", cursor: "pointer",
            }}>
              <input
                type="checkbox"
                // `?? true` mirrors the column default, so a backend from
                // before the migration doesn't render the switch as OFF and
                // invite a pointless write to turn on something already on.
                checked={settings.proactive_enabled ?? true}
                onChange={(e) => patch({ proactive_enabled: e.target.checked })}
              />
              Let Gooni speak first
            </label>
            <p style={{
              margin: "6px 0 0", fontSize: 11,
              color: "var(--gooni-muted, #A0A0A5)", lineHeight: 1.5,
            }}>
              A background loop looks at your activity and commitments every
              ~15 min and places one line on the home when it has something you
              don't already know — and texts you on WhatsApp instead if you've
              been away for hours. Off means silence, no model calls.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
