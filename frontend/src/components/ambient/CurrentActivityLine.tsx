import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { ink } from "./ambientInk";
import { FEED_REFRESH_MS, fetchCurrentActivity, type CurrentActivity } from "../../services/api";

// ONE calm line above the wave: what you're actually doing, mirrored back.
// It's a mirror, not a notification: it names the frontmost app/tab and how
// long, and nothing else — no scoring, no judgement.
//
// IT WEARS A CONTAINER, which is a deliberate reversal of the centre-of-screen
// treatment rule (captain review, 2026-08-15). As bare text it read as a stray
// caption that had drifted over the wave rather than a thing the app was
// saying. The container is what makes it a discrete element — but it stays
// SUBTLE for the reason the rule exists: a lit card at the centre becomes a
// second anchor and competes with the wave. So: a low-alpha ground, a hairline,
// no blur and NO SHADOW (the 2026-08-02 no-bloom rule still holds), and it only
// appears when there is something to say. Silence renders nothing at all — an
// empty pill hovering over the wave is exactly the permanent-signal-you-stop-
// reading trap the grindstone line was deleted for.

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ICON = 14;

/**
 * The site's OWN favicon, never a third-party favicon service.
 *
 * `https://icons.example/…?domain=<host>` would ship every host Daniel looks at
 * to someone else, which is precisely what the browser sensor's privacy model
 * exists to prevent (the extension popup refuses the same shortcut and uses
 * chrome's own cache). Asking the host itself is a request to a site already
 * being visited, so it discloses nothing new.
 */
function faviconUrl(host: string): string | null {
  if (!host) return null;
  try {
    return new URL("/favicon.ico", `https://${host}`).toString();
  } catch {
    return null;
  }
}

/**
 * The identity glyph. A favicon when one loads; otherwise the first letter.
 *
 * A missing icon must never leave a hole where the glyph was — the pill is one
 * element and a gap in it reads as broken, so the letter chip is the ground the
 * favicon paints over and the `onError` swap is back to something, not to
 * nothing. Desktop apps have no fetchable icon at all (an app name is not a
 * URL), so they are always the chip.
 */
function ActivityIcon({ name, src }: { name: string; src: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const letter = (name.trim()[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden
      style={{
        width: ICON,
        height: ICON,
        flex: "none",
        borderRadius: 3,
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        background: ink(0.1),
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: 0,
        color: ink(0.55),
      }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={ICON}
          height={ICON}
          onError={() => setFailed(true)}
          style={{ width: ICON, height: ICON, objectFit: "contain", display: "block" }}
        />
      ) : (
        letter
      )}
    </span>
  );
}

export function CurrentActivityLine() {
  const [activity, setActivity] = useState<CurrentActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const a = await fetchCurrentActivity();
        if (!cancelled) setActivity(a);
      } catch {
        /* ambient — stay quiet */
      }
    };
    void load();
    const id = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Prefer the desktop app over the browser tab — frontmost app is the
  // broader context (it's what's actually on screen; a background browser
  // tab isn't necessarily what you're looking at).
  const shown = activity?.app
    ? { name: activity.app.name, sec: activity.app.duration_sec, icon: null }
    : activity?.browser
      ? {
          name: activity.browser.host,
          sec: activity.browser.duration_sec,
          icon: faviconUrl(activity.browser.host),
        }
      : null;

  if (!shown) return null;

  return (
    <div
      className="gooni-activity-breathe"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "4px 11px 4px 8px",
        borderRadius: 999,
        // INK-TINTED, not `surf`: the surface colour is near-black on the dark
        // void, so a `surf` pill is invisible in exactly the theme this was
        // reported on. A low-alpha ink tint lifts off the ground in BOTH — pale
        // on the dark void, faintly darker on the light one — which is the same
        // trick the rail's hover state uses.
        background: ink(0.055),
        border: `1px solid ${ink(0.08)}`,
        fontFamily: FONT,
        fontSize: 12.5,
        letterSpacing: 0.2,
        color: ink(0.42),
        userSelect: "none",
        maxWidth: "100%",
      }}
    >
      {/* Ambient breathe: the wave drifts continuously, so a perfectly static
          pill reads as a frozen object on a living surface. Slow opacity +
          sub-threshold translateY on one long cycle — felt, not seen, and
          deliberately NOT synced to the wave. Transform/opacity only (no
          layout shift), disabled under prefers-reduced-motion. */}
      <style>{`
        @keyframes gooni-activity-breathe {
          from { opacity: 0.4; transform: translateY(-2px); }
          to   { opacity: 0.6; transform: translateY(2px); }
        }
        .gooni-activity-breathe {
          animation: gooni-activity-breathe 7s ease-in-out infinite alternate;
        }
        @media (prefers-reduced-motion: reduce) {
          .gooni-activity-breathe { animation: none; }
        }
      `}</style>
      <ActivityIcon name={shown.name} src={shown.icon} />
      <span
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {shown.name} · {fmtDuration(shown.sec)}
      </span>
    </div>
  );
}
