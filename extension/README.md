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
5. Enter your **Gooni password** and **Save**. The **Gooni base URL** already
   defaults to `https://gooni-bot.fly.dev` — change it to `http://localhost:8000`
   only when you are deliberately testing against a local backend.

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

A parameter's value is redacted if **any of three checks** fires on its name.
Three, because the two simpler designs were each wrong in one direction, and
both directions cost something real — over-redaction destroys the value before
the interval is buffered (unrecoverable), under-redaction stores a live
credential.

1. **Squashed whole-name.** Lowercase, delete every `_`/`-`, compare against a
   set of glued credential names (`jsessionid`, `accesstoken`, `xapikey`, … —
   `SCRUB_SQUASHED_NAMES` in `src/scrub.js` is the list). This is the only
   check that can catch a run-together name with no boundary to split on, and
   it is what keeps the `api_key` / `x-api-key` family covered once `key` stops
   being a segment. Entries here are stored pre-squashed, since that is what
   they are compared against.
2. **Whole name only:** `code`, `key`, `state`. Bare `?code=`/`?state=` are the
   OAuth pair. They are deliberately *not* segments — as segments they ate
   `zip_code`, `country-code`, `error_code`, `promo_code`, `sort_key`,
   `product_key`, `us_state`, `page_state`.
3. **Segments.** Lowercase, split on `_`, `-`, **camelCase** boundaries and
   digit boundaries, redact if any piece is on the list. So `token` covers
   `access_token`, `id_token`, `X-Amz-Security-Token` *and* `accessToken`,
   `idToken`, `authToken`; `session` covers `sessionId`; `secret` covers
   `clientSecret`; and a compound nobody thought to list — `my_auth_token`,
   `gh-session-key` — is caught by its parts. What it does *not* do is eat
   ordinary params: `auth` leaves `author`/`authors` alone, `sig` leaves
   `assignee`/`design`/`designer`/`insight` alone.

The **segment list (check 3) is the editable one** — it is the family list, the
thing you extend when a site invents a new way to name a secret. Saving it
**replaces** the default rather than extending it; a list you can only add to
is not editable. **Reset scrub list to defaults** puts the defaults back in the
form so the usual edit is "defaults plus mine". Checks 1 and 2 are structural
rather than editorial (names with no boundary; the three bare OAuth params) and
stay fixed, so emptying the textarea cannot switch them off.

Defaults live in `src/scrub.js` (`SCRUB_SEGMENTS`, `SCRUB_WHOLE_NAMES`,
`SCRUB_SQUASHED_NAMES`). The server-side floor in
`app/services/browser_activity_service.py` runs the **same three checks over
the same three sets** and is **not user-editable at all** — trimming an entry
here narrows what the extension redacts, but a broken or hand-rolled client
still cannot get under the floor. Both sides are pinned by the same literal
KEPT/REDACTED table (`tests/scrub.test.js` and `tests/test_browser_intervals.py`)
so they cannot drift apart.

That floor additionally strips HTTP-basic userinfo
(`https://alice:hunter2@host/…` → `https://REDACTED@host/…`); the extension
never sends it in the first place, since it rebuilds the URL from `u.host`.

**Known limitation.** The matcher recognises credentials by parameter *name*,
so an unusual name that is not in any of the three sets and has no recognisable
segment will be stored verbatim. Add it to the segment list on the options page
when you meet one; the server floor is a fixed non-editable minimum, not a
complete guarantee.

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
- **Idle is part of "is anything focused", not a separate event path.** A
  focused Chrome window is not an attending human: walking away does not
  unfocus the window, so `getLastFocused().focused` stays true through a
  two-hour lunch. Every reconcile therefore asks `chrome.idle.queryState`
  first, and anything other than `active` means no attention — otherwise the
  30s heartbeat re-opens an interval that `chrome.idle` had just correctly
  closed and the idle stretch is credited as focus time. Because it lives in
  the one decision every event path funnels through (`src/attention.js`), the
  heartbeat doubles as a second idle detector: if the worker was asleep when
  `chrome.idle` fired and the transition was missed, the next heartbeat still
  closes the interval at its last confirmed beat. The probe fails **closed** —
  if it throws or does not answer within 2s it reports `idle`, because this
  sensor's errors are meant to be undercounts.
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

## Noticing that it stopped delivering

The delivery rules below are very careful never to **lose** data. What they had
no way to say was that data had stopped **arriving**, and every failure mode was
invisible unless you opened the options page and read a flush record:

- the default `baseUrl` used to be `http://localhost:8000` — a backend that only
  exists while `dev.sh` is running, so a fresh install buffered against nothing
  and looked fine. **It now defaults to `https://gooni-bot.fly.dev`.** That is
  the same choice `enabled` already makes: an installed sensor that senses
  nothing is worse than no sensor. Refusing to run until configured fails in the
  other direction — a fresh install would record nothing until someone visited
  the options page, which is the same lost data with a better excuse. Nothing is
  lost by a wrong-but-reachable default either, since everything is buffered
  until the server confirms it; pointing it at the right place later delivers the
  backlog.
- with **no password saved**, `flushOnce` returns `not_configured` with
  `sent: 0`, and `recordFlush` deliberately does not persist zero-sent flushes —
  so `gooni_last_flush` stays null *forever* while the buffer grows. There was
  literally nothing to read.

So the toolbar icon now carries the answer. `src/health.js` computes it from
**config and buffer state**, not from the last flush record, precisely because
the worst states never write one:

| State | Badge |
|---|---|
| Healthy | nothing — a permanent badge is one you stop reading |
| No password saved | red **!**, "nothing can be delivered, N interval(s) waiting" |
| Password rejected (`401`) | red **!**, distinct from having no password |
| Send failing with a backlog ≥25 | red **!**, naming the host, since a wrong host *is* the bug |
| One failed send | amber **!** |
| `Retry-After` backpressure | nothing — the buffer holds, the next alarm delivers |
| Past loss (`refused`/`dropped`) | amber **!**, and it stays visible after delivery recovers |
| Paused in options | grey **‖**, never reported as broken |

The popup repeats it as a banner at the top, rendered *before* the summary
fetch — the states worth flagging are the ones where that fetch is about to
fail, so the reason has to arrive with the failure rather than after it.

## Buffering and delivery

Closed intervals go into `chrome.storage.local` and are flushed in batches —
never one request per tab switch, and never a lost interval when the laptop is
offline.

- Flush runs on a 60-second alarm and immediately once 25 intervals are queued.
  A flush that hangs is aborted after 20 seconds and retried like an offline
  one: every flush shares the one-writer queue with the tab events, so a server
  that accepts the connection and then goes quiet would otherwise hold that slot
  and stall the sensor with nothing erroring.
- **Nothing leaves the buffer until the server confirms it.** Keeping the data
  is the default and dropping it is the exception: only a `2xx` (the server took
  a position on every row) or one of `400`/`413`/`422` (a body that will be
  refused identically forever, so retrying would wedge the buffer behind one
  poison batch) clears the sent ids. Everything else — offline, `5xx`, `401`,
  `404`, `408`, `429` — leaves the buffer untouched for the next attempt. `429`
  and `404` are the two that matter in practice: Gooni's rate limiter answers a
  burst with `429` having stored nothing, and a `404` is a `baseUrl` pointing at
  the wrong host or dev port, which is a config mistake to fix in options rather
  than a reason to lose the backlog. A `Retry-After` header is honoured (capped
  at 15 minutes) before the next flush is attempted. A dropped batch is data
  **destroyed** — the server stored none of it and it can never be redelivered —
  so it is counted rather than reported as a bare `error http_400`, which reads
  like something to retry.
- **Retries cannot double-count.** Each interval gets a `client_id` (UUID) when
  it closes, which never changes; the ingest endpoint upserts on it, so a batch
  the server stored but whose response we never saw dedups on the way back in.
- **One writer at a time.** chrome dispatches listeners back-to-back without
  awaiting them, and every storage mutation here is a read-modify-write, so all
  of them are funnelled through a single promise-chain queue (`src/serial.js`).
  Without it, the `onActivated` + `onUpdated` pair chrome delivers on one tab
  switch closes the same span twice into two different `client_id`s — an
  overcount the server cannot dedup, because the ids differ by construction. The
  queue only orders work inside one service-worker generation; all real state is
  in `chrome.storage.local`, so a worker torn down mid-queue restarts clean with
  no lock to leak.
- The buffer holds 5000 intervals. Past that the **oldest** are dropped and the
  count is kept — a gap is admitted rather than hidden. The options page keeps
  the two losses apart, because the fix differs: `dropped:` is buffer overflow
  (only after a very long outage), `refused:` is intervals destroyed because the
  server refused the batch. Both counters are durable. A single *row* the server
  rejected mid-batch was acked and deleted like an accepted one, so it shows up
  only in the last-flush line — which is why an empty flush leaves the previous
  line standing instead of overwriting it a minute later.
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

Gooni derives its `opened <host>` log rows from those same rows at READ time —
no extension change, no new storage, and no attribution (a row says what
happened and when, nothing more). The rule lives server-side in
`app/services/device_activity.py`; see the *Device rows* section of the
repo-root `CLAUDE.md`.

## The popup (what you actually looked at)

Clicking the toolbar icon opens `popup.html`: a headline total for the selected
period (today / last 7 days), a 7-day trend chart, and the ranked per-host list
— favicon, domain, `1:13:10`, a proportional bar, share of the period, and the
session count.

It reads ONE endpoint, `GET {base}/browser/intervals/summary?days=N` (or
`?start=&end=`), which folds everything in SQL — `GROUP BY host` and a
`GROUP BY` over per-day CASE buckets built from LOCAL midnights. The popup
never downloads a raw interval: a tab-focus sensor writes thousands of rows a
week, and a popup that summed them in JavaScript would be visibly slow within a
month and would keep getting slower. Days are LOCAL days; the buckets are
computed per-day as tz-aware midnights, so a DST switch inside the window lands
on the right side of midnight. An interval that crosses midnight is attributed
wholly to the day it STARTED on.

Three honesty rules, all of them load-bearing:

- **Salvaged intervals are counted and marked.** A `truncated` row was closed at
  its last heartbeat because the browser died mid-span, so its duration is a
  floor rather than a measurement. It stays in the total (dropping real
  attention understates the day), the trend bar shows that share hatched, the
  host row carries a `⚑`, and a line under the headline says how much of the
  period it is.
- **Unsent intervals are named.** If anything is still buffered, the popup says
  so and says the totals exclude it — otherwise a number that looks low because
  a flush has not landed is indistinguishable from a genuinely quiet day.
- **Empty reads as empty.** No rows for the period gives "No data yet" and an
  em-dash headline, never `0s`. A fetch that FAILS says so too, rather than
  falling back to rendering zeros — "0s" is a claim about the day, and an
  unreachable server is not evidence for it.

The popup is read-only. It touches nothing in the sensing path beyond asking the
service worker for its buffered count (the existing `gooni:status` message).
Attribution to a Topic or Promise, focus scoring and productivity judgements are
all deliberately absent — `browser_intervals` is a raw substrate and the popup
reports it, nothing more.

The `favicon` permission is chrome's own favicon cache. No third-party favicon
service: that would ship every host you visit to someone else, which is what
this extension's privacy model exists to prevent. A host chrome has no icon for
falls back to a letter chip.

## Tests

```bash
cd extension && npm test      # node:test, no dependencies
```

Covers interval closing (tab change, navigation, blur, lock), idle handling and
its backdating, the poll-vs-event close distinction, orphan salvage, buffer
persistence across a restart, which statuses retain vs drop a batch,
`Retry-After` parsing, overflow accounting, URL scrubbing, the write queue
(each race test asserts the unserialized control case loses/duplicates first, so
it fails if the queue is removed), the last-flush report's wording, and the
health/badge rule (`tests/health.test.js` — including that no-password is an
error even though it never writes a flush record, that backpressure is not a
failure, and that a live outage outranks historical loss).

The idle tests drive the real `resolveAttention` + `applyAttention` +
`FocusTracker` composition with only chrome's probes faked — the same path
`reconcile()` runs — so "an idle machine accrues no focus time" is asserted
against the reconcile loop rather than against `FocusTracker` alone. A two-hour
idle stretch with Chrome focused and the heartbeat ticking must emit nothing.

Popup formatting is `tests/format.test.js` — the clock and headline forms
(including a multi-hour total and a span crossing midnight), the floor-not-round
rule, `<1%` for a host that holds real time, local-time day labels, and the
wording of the salvaged/unsent notices.

The server side is `python tests/test_browser_intervals.py` (idempotency
including a collision mid-batch, validation, the scrub backstop over both `url`
and `path`) and `python tests/test_browser_summary.py` (the aggregation: local
day buckets vs UTC, a midnight-crossing span, truncated counted inside the total
AND separately, a multi-hour total, and an empty period that stays empty).

## Layout

```
manifest.json      MV3 manifest — permissions: tabs, idle, storage, alarms,
                   favicon; action → popup.html, options_page → options.html
options.html/.js   connection + the editable scrub lists + status
popup.html/.js     the toolbar glance: period total, trend, ranked hosts
src/background.js  the ONLY file that touches chrome APIs (event wiring)
src/tracker.js     the interval state machine (pure, fake-clock testable)
src/buffer.js      chrome.storage.local buffer + flush/retry rules
src/scrub.js       URL scrubbing — the privacy model
src/attention.js   "is the human here, and on what?" — the idle-aware decision
src/serial.js      the one-writer queue every storage mutation goes through
src/status.js      the options page's last-flush report (incl. rejected rows)
src/health.js      "is this thing delivering?" → the toolbar badge + popup banner
src/format.js      popup display formatting (durations, shares, honesty notes)
src/config.js      stored settings
```
