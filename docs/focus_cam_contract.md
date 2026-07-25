# Focus-cam → Gooni HTTP contract (sidecar side)

The **brain side** (Gooni) is built. This doc is the contract the local macOS
**sidecar** (built separately) codes against. Gooni runs on Fly behind the home
NAT it can't reach into, so **all traffic is sidecar-initiated / polling** — no
SSE, no push to the Mac.

Every request carries the same Bearer token as the rest of Gooni:

```
Authorization: Bearer <token>
Content-Type: application/json
```

Base URL: `https://gooni-bot.fly.dev` (prod) or `http://localhost:8000` (dev).

Timestamps are ISO-8601 **with offset** (e.g. `2026-07-24T14:03:00-07:00`). Gooni
places calendar days in Daniel's configured tz — a naive string is assumed local.

## Control loop (declarative reconcile)

Gooni stores desired `control`; the sidecar reconciles to it. This is
self-healing — a Start clicked while the sidecar was asleep takes effect on wake.

```
GET /focus/cam
→ {control, state, score, app, session_id, at,
   frame, frame_at}          # frame = data:image/jpeg;base64,… | null (see Preview frame)
```

Poll ~every 2s. Read `control`:
- `running` and you're idle → start sensing, mint a `session_id`, begin reporting.
- `idle` and you're running → stop + finalize (POST the session), then go quiet.

The **sidecar owns `session_id`** — Gooni never generates it.

## Reporting live state

```
POST /focus/cam/state
{ "session_id": str, "at": iso8601+tz,
  "state": "focused"|"distracted"|"away"|"paused",
  "score": float|null, "app": str|null }
→ {ok, state, control}
```

Send on state-change **and** a ~30s keepalive (keeps Settings churn low). Merges
into the blob; leaves `control` untouched.

## Preview frame (liveness)

```
POST /focus/cam/frame
{ "session_id": str, "at": iso8601+tz,
  "state": "focused"|"distracted"|"away"|null,
  "jpeg_b64": str }              # base64 JPEG, ~320px wide, no data: prefix
→ {ok}
```

Ship on a ~10s timer **and** on every state flip while running. ~10–20 KB
(320px, JPEG q60). **Latest only — Gooni overwrites, no history** (folded into
the same Settings blob as live state; nothing per-frame is persisted). Server
caps the payload at 200 KB base64. Gooni re-exposes it on `GET /focus/cam` as
`frame` (a ready-to-render `data:` URL) + `frame_at`.

**Freshness = liveness.** The widget hides the thumbnail and shows
"offline · not sensing" once `frame_at` is older than ~40s (4 missed frames) —
the signal that stops a dead sidecar from looking like it's still `RECORDING`.
So keep frames flowing the whole time a session runs.

## Discrete events

```
POST /focus/cam/events
{ "session_id": str, "kind": "distracted"|"phone"|"vape"|"stand"|"left_desk",
  "started_at": iso8601+tz, "ended_at": iso8601+tz|null,
  "duration_sec": int|null, "activity": str|null, "evidence_id": str|null }
→ {ok, count}   # the day's running count for that kind
```

Each POST is +1 on the `"focus {kind}"` daily counter (local day of `started_at`).
`activity` / `evidence_id` are accepted now (ride in `value_json`) but unused by
Gooni — the seam for the later VLM/evidence work.

## Session summary (on stop)

```
POST /focus/cam/sessions
{ "session_id": str, "started_at": iso8601+tz, "ended_at": iso8601+tz,
  "duration_sec": int, "focus_score": float,
  "presence_pct": float, "eyes_on_pct": float, "active_pct": float, "engaged_pct": float,
  "counts": {"distracted": int, "phone": int, "vape": int, "stand": int, "left_desk": int},
  "note": str|null, "activity_summary": null }
→ {ok, entry_id}
```

The whole body is stored verbatim in `value_json` (loose — extra fields are fine).
`focus_score` is also mirrored to a numeric trackable for future charting.

## Notes

- Focus data is **walled off** from every existing Gooni trackable surface (log
  matrix, dots, activity rail, overlay, chat). It's visible only in the Focus
  widget / the `/focus/cam/*` reads. Don't expect it in `/trackables`.
- The UI Start/Stop button hits `POST /focus/cam/control {control: running|idle}`
  — you only ever *read* control, never set it.
- The auth model for the prototype is URL/token secrecy; the sidecar→Gooni hop is
  the standard Bearer-gated path.
