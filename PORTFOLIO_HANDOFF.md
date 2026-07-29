# Portfolio work — handoff

Written 2026-07-29, end of a long session. Everything below is either
verified or explicitly flagged as unverified. Gitignore this file or delete
it once the work lands.

---

## 1. Answering the question that prompted this doc

> *"tf i thought we would start at our original start. with the birds eye view
> gooni plaza and then we jump in the hole no?"*

**That is what was built.** The flow exists:

```
/creative  →  bird's-eye landing ("daniel's plaza", nickname + colour)
           →  drop in, intro swoop
           →  hop 2 tiles north to the hole (square gap in the floor, signed "JUMP IN")
           →  step beside it: camera reframes close + a retro prompt box appears
           →  hop in  →  jump, beat, screen darkens
           →  /walk   (the scroll narrative, walked by the colour you picked)
```

**Why it may not have looked like that:** `/walk` is *also* directly reachable,
and that's how it kept getting opened during review. Opening `/walk` cold skips
the plaza entirely. The plaza is the intended front door; `/walk` should
eventually not be linked directly.

**Also unverified end-to-end.** The drop was never watched happen. See §4.

---

## 2. Current state

### Shipped to `main`
- **PR #442** — the walk, the plaza portal, public access, résumé, content fixes.
- Branch `restore-gooni-links` — **unpushed**, has the post-public link
  restoration + the fixes from §3.

### Routes
| Route | What it is | Public? |
|---|---|---|
| `/creative` | The plaza. Front door. Contains the hole. | yes |
| `/walk` | The scroll narrative. Temporary URL. | yes |
| `/public` | Notes index (the old public page) | yes |
| `/public/cv` | Flat text portfolio | yes |

`/creative` and `/walk` render outside `PasswordGate` (`routes/__root.tsx`,
`isChromelessPath`). Verified they only read `GET /public/*`, which the backend
already exempts. `QuickNav`/`QuickComposer` are gated off public routes.

### Content
**One spine, two consumers.** Edit these, both surfaces update:
- `frontend/src/content/walk.ts` — the six walk stations
- `frontend/src/content/portfolio.ts` — projects/roles for `/public/cv`

⚠️ **These two files duplicate Kreatify/Gooni/Lucid and have already drifted
once.** Merging them is unfinished work.

### Résumé
- Source: `~/Desktop/resume/Daniel_Gunawan_Resume_2026.tex`
- Build: `cd ~/Desktop/resume && tectonic Daniel_Gunawan_Resume_2026.tex`
- Served copy: `frontend/public/DANIEL_RESUME.pdf` (keep in sync manually)
- Self-contained on stock `article` — the old master needed a `resume.cls`
  that isn't installed and isn't on CTAN.

### danis-website (`~/Desktop/projects/danisWebsite`)
- Gooni added as **lead featured project**, with the deletion story + repo link.
- **2 commits unpushed. Nothing is live.**
- **Still has no screenshot** — deliberately: a shot of the running app shows
  the activity rail, i.e. real note titles and message previews. Daniel should
  choose the frame, not an agent.

---

## 3. Fixed this session (last commit `b43c729`)

- **Snapping fought the user.** Was `mandatory` + `scroll-snap-stop: always`,
  which snapped back on a few pixels of movement and made the walk cycle
  stutter (the character chases scroll velocity; mandatory produces constant
  tiny reversals). Now `proximity`.
- **Props floated in the void.** Roadside clutter was placed 3.5+ units beyond
  the tile field, where no ground exists. Now on the outer tile columns, seated
  at `+TILE_HEIGHT/2`. Off-path scenery got floating islets.
- **Escape button** — fixed "read the page instead" link, top-right of `/walk`.

---

## 4. Known-broken / unfinished, in priority order

1. **The static page is wrong.** Daniel: *"the static page shouldn't be the cv.
   we should merge best of both worlds between the cv and the /public page."*
   Currently `/public/cv` is résumé-shaped and `/public` is a notes index.
   They should become **one** page: the portfolio content *plus* the writing.
   This also resolves the `walk.ts` / `portfolio.ts` duplication above.
2. **Nothing in the 3D is verified in motion.** The preview pane runs with
   `document.visibilityState === "hidden"`, so `requestAnimationFrame` never
   fires and R3F's loop never runs. Every screenshot is a stale first frame.
   **Camera framing, the walk cycle, the snap feel, and the plaza→walk drop
   have never been seen working.** Only Daniel's screenshots are evidence.
   Do not trust an agent's "looks good" on anything animated.
3. **No scars in 3D.** The two ripped-out systems (ReAct/Reflexion, the
   intelligence layer) are struck through in text only. The whole thesis was
   that you *physically step over* what was deleted. Unbuilt.
4. **Station images don't render.** `walk.ts` carries `image`/`imageAlt` for
   the origin and Kreatify stations; the layout never surfaces them.
5. **Orphaned landmark system.** `Landmark.tsx`, `Landmarks.tsx`,
   `LandmarkPeekHost.tsx`, `landmarkBus.ts` (~958 lines) are unmounted and
   unused. **Do not just delete the directory** — `noteTileMap.ts` imports
   `isReservedTile` from `landmarkPlacement.ts`, and `PORTAL_TILE` (0,-2)
   collides with the old `SLOTS.gooni`. Remove the reservation coupling first
   or a note-coin can land on the portal tile and teleport visitors.
6. **Bundle is one 2.4MB chunk.** `/walk` ships the entire app (incl. Tiptap)
   to every visitor. No code-splitting.
7. **No SEO.** `index.html` hardcodes `<title>Gooni</title>`; no meta
   description, no `og:*`. Every shared link previews as "Gooni".
8. **`~27` habit identifiers remain in source** (`metrics.py`,
   `trackable_tools.py`, extraction prompts, `daily_metric_service`,
   `focus_cam_service`). `CLAUDE.md` was degeneralised; the code was not.
   Renaming is a functional change needing a migration.

---

## 5. Security posture

- `gitleaks detect`: **1,158 commits, no leaks.** Config at `.gitleaks.toml`
  allowlists two localStorage key names *by value* (not by disabling the rule).
- No `.env`, no `.db`, no `.mcp.json` secret ever committed. The DB with
  personal data has never been in git — habit names appear as schema
  identifiers only, never with values.
- **Repo is now public.**
- ⚠️ **Secret-scanning push protection is `disabled`.** Enable at
  Settings → Code security → Push protection. Rulesets ≠ push protection.
- If adding a ruleset: target `main` only, enable **Block force pushes** and
  **Restrict deletions**, leave the bypass list empty. Do **not** require PRs —
  `version-bump.yml` pushes directly to `main` and would break.

---

## 6. Validation commands

```bash
cd frontend && npx tsc --noEmit && npm run lint && npm test && npm run build
source venv/bin/activate && python tests/test_imports.py \
  && python tests/test_signal_routing.py && python tests/test_overlay.py
gitleaks detect --no-banner --redact
```

All green as of `b43c729`.

---

## 7. Content facts worth not re-deriving

Published figures were audited; several did **not** reproduce and were replaced.
Do not reintroduce these:

| Claim | Status |
|---|---|
| "831 commits" | wrong (843+) and rots every push |
| "190,101 lines written" | reproduces under neither `--shortstat` nor `--numstat` |
| "20→6 tables" | described the primitive layer; there are 25 tables today |
| "63.6k lines / 62% deleted" | contradicted the other content file |
| "+3,229% settings discovery" | true but reads as fake (baseline ≈ 0) |

**Verified and safe to use:** 22 tables dropped in one PR; PR #404 is exactly
`+1,298 / −32,252`; ~119k deletions across `main`; 5 months solo.

**Ordering:** Lucid came *first* (585 commits in 2024), then life_ai, then flow,
then Gooni — this contradicts the original telling and git wins.

**Do not put on a public résumé:** the unreleased product name, ticket IDs,
internal doc titles, or the internal package name.
