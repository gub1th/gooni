# Gooni Browser Sensor

A Manifest V3 Chrome extension that records **which tab actually had your
attention, and for how long**, and ships those intervals to Gooni.

It exists to answer one question without you doing anything: *when I say I'm
working on something, am I actually on it, or am I on other tabs?* The browser
already knows both halves — the URL is the task identity, and how long a tab
held focus is the timer. This is the ambient version of creating a task named
after a LeetCode problem and starting a stopwatch by hand.

It is a **sensor only**. It records raw intervals and stops there. It does not
attribute attention to a Topic or a Promise, does not score anything, and has
no dashboard. Those need a design of their own, and building them on top of
un-designed attribution is how you get confidently wrong numbers.

## Install (unpacked, dev mode)

There is no build step and no dependencies — the files in this directory are
the extension.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` directory.
4. Click **Details ▸ Extension options** (or the puzzle-piece menu ▸ Gooni
   Browser Sensor ▸ Options).
5. Set the **Gooni base URL** (`http://localhost:8000` for local dev,
   `https://gooni-bot.fly.dev` for prod) and your **Gooni password**, then
   **Save**.

The password is exchanged once at `POST /auth` for the bearer token, exactly as
the web app does; only the token is stored.

If you point it at a host other than `localhost:8000` or `gooni-bot.fly.dev`,
saving will prompt for permission to talk to that host. Granting it is
required — without the host permission the service worker's requests are
blocked by CORS and intervals pile up in the buffer undelivered. The options
page's **Status** section will say so.

> **Chrome 137+ note:** the `--load-extension` command-line flag no longer
> works. Loading from the Extensions page (above) is the supported path;
> automated harnesses need `--enable-unsafe-extension-debugging` plus
> `--remote-debugging-pipe` and the CDP `Extensions.loadUnpacked` command.

## Privacy model

**Full URLs are captured, for every host.** Hostname-only was considered and
rejected: "what was I distracted by" is the whole question, and `youtube.com`
does not answer it while `youtube.com/watch?v=…` does. The primary use case
needs the path outright — a LeetCode problem's identity lives in
`/problems/minimum-genetic-mutation/`. Page titles are captured too.

**Credentials are not captured.** Any query parameter whose *name* looks
credential-bearing has its value replaced with `REDACTED` before the URL is
written to disk, so OAuth callbacks, magic links and password-reset links can
never land in the log. The URL **fragment** (`#…`) is always dropped whole —
implicit-flow OAuth returns `#access_token=…` there, and a fragment carries no
identity worth the risk. Everything else in the query string survives on
purpose: `?v=` is a YouTube video id, and that is exactly what the log is for.

The scrub happens **before the interval is buffered**, so a secret never
reaches disk or the network. Gooni re-runs an equivalent strip server-side
(`browser_activity_service.scrub_url`) as a backstop against an old extension
build or a hand-rolled client.

Not recorded at all: `chrome://`, `chrome-extension://`, `about:`, `file://`,
`devtools://` — browser furniture and local disk paths, neither of which is
web attention.

### Editing the scrub list (no rebuild)

Options page ▸ **Privacy: scrubbed query parameters**. Two lists:

- **Substring matches** — matched anywhere in the parameter name, so one entry
  covers a family: `token` catches `access_token`, `id_token`, `refresh_token`,
  `X-Amz-Security-Token`.
- **Exact matches** — matched against the whole name, for names too common to
  match as substrings (`code`, `key`, `state`; matching those as substrings
  would eat `zipcode`, `keyword`, `estate`).

Saving a list **replaces** the corresponding default rather than extending it —
a list you can only add to is not editable. **Reset scrub lists to defaults**
puts the defaults back in the form so the usual edit is "defaults plus mine".

Defaults live in `src/scrub.js` (`SCRUB_SUBSTRINGS`, `SCRUB_EXACT`) and are
mirrored by the server-side floor in
`app/services/browser_activity_service.py`.

## How an interval is measured

Exactly one interval is open at a time, because exactly one tab in one focused
window can hold attention. It closes when:

| trigger | `end_reason` |
|---|---|
| the active tab changes | `tab_change` |
| the active tab navigates | `url_change` |
| focus leaves the window / Chrome | `window_blur` |
| the machine goes idle (`chrome.idle`) | `idle` |
| the screen locks | `locked` |
| the browser died and the record was found orphaned | `truncated` |

Three details decide whether the numbers are honest rather than merely
plausible:

- **Idle is required, and backdated.** `chrome.idle` reports idle only after 60
  seconds of no input, so those 60 seconds were already not attention. The
  interval closes at `now − 60s`, not at `now`. Without idle handling a tab
  left open overnight reports a sixteen-hour focus session and every number
  downstream becomes a lie.
- **A backgrounded window is not attention.** Losing focus ends the interval.
  On macOS, `chrome.windows.onFocusChanged` does **not** fire when another
  application takes the foreground (verified against Chrome 151 — the listener
  is never called, though `chrome.windows.getLastFocused()` immediately reports
  `focused: false`). A 30-second heartbeat poll is therefore the real detector,
  and it closes the interval at the **last heartbeat that confirmed attention**,
  never at the poll that discovered its absence. Consequence: an interval ended
  by alt-tabbing away is accurate to within one heartbeat, and the error is
  always an **undercount**. An interval shorter than one heartbeat that ends
  that way is dropped entirely rather than guessed at.
- **A salvaged interval is labelled.** If the browser is killed mid-interval
  there is no end event, so on the next start the stranded record closes at its
  last heartbeat — not at startup time, which would report the hours the
  browser spent dead — and the row carries `truncated: true` so nothing
  downstream mistakes a salvaged span for a measured one.

Intervals shorter than one second are dropped as tab-switch noise.

## Buffering and delivery

Closed intervals go into `chrome.storage.local` and are flushed in batches —
never one request per tab switch, and never a lost interval when the laptop is
offline.

- Flush runs on a 60-second alarm and immediately once 25 intervals are queued.
- **Nothing leaves the buffer until the server confirms it.** Offline, a 5xx or
  a 401 leave the buffer untouched for the next attempt. Only a 2xx (or a 4xx
  that would fail identically forever) clears the sent ids.
- **Retries cannot double-count.** Each interval gets a `client_id` (UUID) when
  it closes, which never changes; the ingest endpoint upserts on it, so a batch
  the server stored but whose response we never saw dedups on the way back in.
- The buffer holds 5000 intervals. Past that the **oldest** are dropped and the
  count of dropped intervals is kept and shown in the options page — a gap is
  admitted rather than hidden.
- Everything survives a browser restart, including the open interval, because
  the MV3 service worker is killed after ~30s idle and cannot hold state in
  memory.

## Where the data goes

`POST {base}/browser/intervals`, bearer-authed like every other Gooni sensor
(iOS Shortcuts `/events`, focus-cam `/focus/cam/*`):

```json
{"intervals": [{
  "client_id": "0fd067a0-…", "host": "leetcode.com",
  "path": "/problems/two-sum/", "url": "https://leetcode.com/problems/two-sum/",
  "title": "Two Sum", "started_at": "2026-08-08T17:00:00.000Z",
  "ended_at": "2026-08-08T17:22:30.000Z", "end_reason": "tab_change",
  "truncated": false
}]}
```

Response: `{"accepted": n, "duplicates": n, "rejected": [{client_id, reason}]}`.
Durations are recomputed server-side from the timestamps — a client-supplied
`duration_sec` is ignored.

Rows land in the `browser_intervals` table and nowhere else. Read them back
with `GET /browser/intervals?day=YYYY-MM-DD&limit=100`.

## Tests

```bash
cd extension && npm test      # node:test, no dependencies
```

Covers interval closing (tab change, navigation, blur, lock), idle handling and
its backdating, the poll-vs-event close distinction, orphan salvage, buffer
persistence across a restart, delivery/retry semantics, overflow accounting,
and URL scrubbing.

The server side is `python tests/test_browser_intervals.py` (idempotency,
validation, the scrub backstop).

## Layout

```
manifest.json      MV3 manifest — permissions: tabs, idle, storage, alarms
options.html/.js   connection + the editable scrub lists + status
src/background.js  the ONLY file that touches chrome APIs (event wiring)
src/tracker.js     the interval state machine (pure, fake-clock testable)
src/buffer.js      chrome.storage.local buffer + flush/retry rules
src/scrub.js       URL scrubbing — the privacy model
src/config.js      stored settings
```
