# Gooni Desktop

An Electron shell that makes Gooni **present** — a menu-bar app with a global
capture hotkey — and gives the **focus-cam sidecar one owner** that starts it,
restarts it when it dies, keeps its output, and stops it cleanly on quit.

## The one decision this makes

**The shell points at the deployed backend — `https://gooni-bot.fly.dev`.**

Not localhost. A local backend only exists while `dev.sh` is running, so
anything pointed at `http://localhost:8000` captures nothing for most of every
day while looking perfectly healthy. Gooni is meant to be ambient, and ambient
requires always-on. The URL is configurable (`apiUrl`), but the default is the
deployed one, and the menu bar says so out loud if you point it at localhost.

That default is forced onto the web frontend too. `frontend/src/services/api.ts`
bakes `VITE_API_URL` at **build** time, so a bundle built for one environment and
loaded by the shell would fall through to localhost. `src/preload-app.js`
exposes `window.__GOONI_API_URL__` before any page script runs, and `api.ts`
prefers it. In a browser it is undefined and nothing changes.

## What a shell does and does not buy you

It does **not** reduce the number of moving parts. The focus-cam sidecar is a
Python daemon and mediapipe keeps Python alive whatever wraps it; the shell adds
an Electron process rather than removing anything.

What it buys is:

- **One owner.** The sidecar's lifetime stops being "a terminal you left open".
- **Presence.** Gooni is in the menu bar instead of being a tab you closed.
- **A hotkey.** An assistant you can talk to mid-thought is worth far more than
  one you have to go find.

## Install / run

```bash
cd desktop
npm install
npm start           # runs against https://gooni-bot.fly.dev
npm test            # node:test, zero deps — 109 tests, no Electron needed

npm start -- --capture   # open the capture overlay instead of the window
```

Config lives at `~/Library/Application Support/gooni-desktop/config.json` and is
written with the resolved defaults on first run. Tray ▸ **Open config file…**,
then **Reload config**.

```jsonc
{
  "apiUrl": "https://gooni-bot.fly.dev",   // THE decision. See above.
  "appUrl": "https://gubith.com",          // the frontend the window loads
  "hotkey": "CommandOrControl+Shift+Space",
  "launchAtLogin": true,
  "hideCaptureOnBlur": true,
  "token": "",                              // usually empty — see Auth
  "authPassword": "",
  "sidecar": {
    "enabled": true,
    "command": "",                          // ← REQUIRED for supervision
    "args": [],
    "cwd": "",
    "env": {}
  },
  "appSensor": { /* … */ }                  // see The frontmost-app sensor
}
```

Environment overrides beat the file (`GOONI_API_URL`, `GOONI_APP_URL`,
`GOONI_HOTKEY`, `GOONI_TOKEN`, `GOONI_AUTH_PASSWORD`, `GOONI_SIDECAR_CMD`) —
that is what you reach for when deliberately pointing one launch elsewhere:

```bash
GOONI_API_URL=http://localhost:8000 npm start
```

## Auth

The capture overlay posts from the **main process**, not the renderer. The
backend's CORS is an allowlist (`ALLOWED_ORIGINS`), so a `file://` page fetching
the API would be blocked, and widening the server's allowlist for a desktop
window would weaken it for the web app. Node has no CORS, so the renderer hands
text over IPC and main does the HTTP.

The token comes from, in order: `token` in config → sha256 of `authPassword`
(the same derivation as `app/common.py::_expected_token`) → **harvested** from
the app window's `localStorage` after you sign in once, which is the normal
path. Until one exists, the tray and the capture overlay both say *not signed
in* rather than failing at send time.

## Supervising the focus-cam sidecar

The sidecar is **not in this repo** — it is a separately-built local macOS daemon
that talks to Gooni over the contract in `docs/focus_cam_contract.md`. The shell
cannot guess how to launch it, so it supervises whatever command you name:

```jsonc
"sidecar": {
  "enabled": true,
  "command": "/Users/you/focus-cam/.venv/bin/python",
  "args": ["-u", "/Users/you/focus-cam/main.py"],
  "cwd": "/Users/you/focus-cam",
  "env": { "GOONI_URL": "https://gooni-bot.fly.dev" }
}
```

`-u` is worth having: without it Python block-buffers stdout when it is a pipe,
and the log stays empty until the buffer fills or the process dies.

Behaviour, and why:

| Situation | What happens |
|---|---|
| No `command` set | State is **`unconfigured`** and the menu bar says so. It never degrades into a quiet "no sidecar today" — this is the state a fresh install sits in and the one most likely to be mistaken for "supervised, nothing to do". |
| `command` is a path that isn't executable | **`failed`**, with the path in the message — rather than an ENOENT crash loop that reads like a broken sidecar. |
| It exits unexpectedly | Restarted on an exponential backoff, 1s → 2s → 4s … capped at 60s. |
| It stays up ≥30s then dies | Treated as *one* death: the ladder resets. |
| It dies fast, 5× in a row | State becomes **`crashlooping`**. Still retrying (the cause may be transient — an unplugged camera, a machine that just woke) but it stops claiming health, because restarting every second forever is a broken sidecar wearing a healthy badge. |
| You quit | SIGTERM to the process **group**, SIGKILL after 5s, and quit **waits** for it. Python daemons spawn helpers; leaving a camera-holding orphan behind is worse than no supervisor, because the privacy light stays on with nothing owning it. |
| `killall` / logout / Ctrl-C | Same path — SIGINT/SIGTERM/SIGHUP are routed into the normal quit. The child is spawned detached (that's what makes the group kill possible), so it does *not* die with the parent on its own. |

Output goes to `~/Library/Logs/gooni-desktop/sidecar.log` (tray ▸ Focus cam ▸
**Open log…**), plus a 500-line in-memory tail. Supervisor commentary is prefixed
`[shell]` so it is never mistaken for something the sidecar printed.

## The menu bar

Silent when healthy — an ambient app that decorates the menu bar at rest is
noise. It shows **⚠** and names the problem when any of these is true:

- the sidecar is unconfigured, failed, or crash-looping;
- macOS is refusing the app sensor Accessibility;
- there is no token, so capture has nowhere to send;
- `apiUrl` is localhost.

All of them, not just the first: a fresh install has three at once.

The app sensor's ordinary state (`App sensor: 31 buffered`) is a menu row, not a
headline. A backlog is normal — the machine was offline — and a permanent
warning is one you stop reading. A refused Accessibility grant is the exception,
because it never clears on its own and until it does the sensor records nothing
while looking installed.

## The frontmost-app sensor

Records **which macOS application was frontmost, and for how long**, and POSTs
closed intervals to Gooni's `/app/intervals`. It is the OS twin of the Chrome
extension, and what it feeds is the `opened <app>` row in Gooni's log — a row
emitted on the first focus of an app after five minutes away from it, so a
normal day adds a readable handful rather than one row per cmd-tab.

It records an application **name** and a duration. Not window titles, not
keystrokes, not content. Everything it produces is visible in Gooni's own log.

**How it asks.** Electron has no frontmost-app API, so it runs

```
osascript -e 'tell application "System Events" to get name of first
              application process whose frontmost is true'
```

once per poll. The alternatives were a maintained npm package (a new dependency
*and* a prebuilt native addon to re-match the Electron ABI on every upgrade) or a
small native helper (a second unsigned binary for macOS to forget the permission
grant of). The scripted query costs a process spawn every `pollMs` and a few tens
of milliseconds of CPU — real, unnoticeable at a 4-second cadence — and buys zero
dependencies and nothing extra to codesign. The precision it gives up doesn't
matter for a row that means "opened after five minutes away".

**It needs Accessibility permission** (System Settings ▸ Privacy & Security ▸
Accessibility). Because the build is unsigned, that grant is re-prompted after a
rebuild — see *Not in v1*.

**The honesty rules**, which are the browser extension's rules restated:

- **Idle is checked first and idle wins.** A frontmost app is not an attending
  human: walking away never changes which app is frontmost, so polling "who is
  frontmost" alone would credit every lunch break to whatever was on screen.
  `powerMonitor.getSystemIdleTime()` reports exactly how long since the last
  input, so the interval closes backdated by exactly that.
- **A salvaged interval says so.** If the shell is killed, the open interval is
  recovered on the next launch and closed at its **last confirmed observation**,
  flagged `truncated` — never at the relaunch, which would report an overnight
  session on whatever happened to be frontmost.
- **Sleep and lock close with a real end time.** Both are delivered before the
  machine goes away, which is why a normal lid-close is a measurement and only a
  hard crash gets salvaged.
- **Durations are recomputed server-side.** Clocks are read; arithmetic is not
  trusted.
- **Delivery retains by default.** A batch is destroyed only on `400`/`413`/`422`
  — a body the server would refuse identically forever. Offline, `5xx`, `429`,
  `404` and a bad token all keep the buffer, so a wrong `apiUrl` or an outage
  costs a retry rather than the day.
- **Quit owes durability, not delivery.** The `shutdown` interval is closed and
  written to disk first — that part is local and synchronous. Delivery then gets
  2 seconds and the shell quits regardless: on a captive portal the POST hangs
  until its own 20s abort, and a windowless menu-bar app must not sit there when
  the rows are already durable and `client_id` makes the next launch's
  redelivery a no-op. (The *sidecar* stop is still fully awaited — it holds the
  camera.)
- **A disk that refuses writes says so.** Nothing is lost when a write fails, so
  it is not a loss counter but a liveness one: the tray leads with
  `NOT SAVING (n writes failed)` while the document on disk is behind memory,
  and one transient failure clears on the next write that lands.

Config lives under `appSensor` in `config.json`:

```json
"appSensor": { "enabled": true, "pollMs": 4000, "idleSec": 90, "flushMs": 60000 }
```

On by default, for the same reason the extension defaults on: an installed
sensor that senses nothing until someone visits a settings screen is the same
lost data with a better excuse. The numbers are clamped — a 100ms poll would
spawn `osascript` ten times a second forever, and a 2-second idle threshold would
close an interval every time you stop to read something.

## Not in v1

**Codesigning and notarization.** This build is **unsigned**, and that has one
consequence worth writing down so it isn't mistaken for a bug: macOS ties
camera, Accessibility and Screen-Recording grants to a binary's identity, and an
unsigned binary's identity changes every time it is rebuilt. So **every rebuild
re-prompts for permissions**, and previously granted ones stop applying. That is
friction, not a blocker — click through it. It is also the reason the *sidecar's*
own camera permission is best left to the sidecar for now: the shell can start a
Python process that holds its own long-lived camera grant, where an unsigned
shell holding that grant itself would lose it on every rebuild.

Signing is what turns this from "works on this machine today" into something
installable, and it is the prerequisite for the shell ever owning the camera
grant directly.

## Layout

```
src/main.js            electron wiring — the ONLY file that imports electron
src/config.js          defaults + merge + env precedence        (tested)
src/sidecar.js         the supervisor: spawn/backoff/stop       (tested)
src/logbuffer.js       line-stitched bounded output tail        (tested)
src/traymenu.js        the menu as data, so wording is testable (tested)
src/api.js             conversations + capture, from main       (tested)
src/reply.js           "did the turn land" vs "was there prose" (tested)
src/token.js           token precedence + sha256 derivation     (tested)
src/frontmost.js       "which app is frontmost?" via osascript   (tested)
src/appfocus.js        the frontmost-app interval state machine  (tested)
src/appreporter.js     buffer + retain-by-default delivery       (tested)
src/appsensor.js       the sensor loop that joins the three      (tested)
src/jsonstore.js       durable state: atomic write, loud loss    (tested)
src/preload-app.js     injects __GOONI_API_URL__, harvests the token
src/preload-capture.js the narrow capture bridge (no token, no fetch)
renderer/capture.*     the overlay
scripts/make-tray-icon.js  regenerates assets/trayTemplate*.png
```

Everything with a decision in it is chrome-free and unit-tested, the same split
`extension/` uses to keep chrome out of its logic modules. `npm test` needs no
Electron and no network.
