---
description: Pull the Gooni engineering backlog (note #56 "Gooni Backlog" in the Dev space, id 4), pick items you're confident implementing without further design input, implement them one at a time, and check them off the note as you finish. Use when Daniel says "work the backlog", "look at the backlog", "pick up backlog items", "what can you knock out", or any variant asking you to make autonomous progress against the queued list. SKIP items that require design discussion, deployment/infra work on shared systems, or destructive changes — surface those to Daniel instead of silently doing them.
---

# Work Backlog skill

Autonomous progress against the Gooni engineering backlog. The backlog lives in a **note**, not in `docs/TODO.md` and not in the dashboard `TodoItem` table — those are separate. The dashboard todos are Daniel's personal life tasks. `docs/TODO.md` is the long-horizon roadmap. This skill targets the **short-horizon engineering queue** that Daniel curates as a task list in a note.

## Locating the backlog

Canonical location: **note #56** titled **"Gooni Backlog"** in the **Dev** space (space id **4**).

If the note id drifts (renamed, recreated), rediscover it:

```bash
# List Dev space notes
curl -s http://localhost:8000/spaces/4/notes | python3 -c "import sys,json; [print(f\"#{n['id']} {n['title']}\") for n in json.load(sys.stdin)]"
```

Pick the note with "backlog" in the title. If nothing matches, stop — ask Daniel rather than guessing.

## Reading the backlog

Use `mcp__gooni__read_note(note_id=56)` to see items as `[ ]` / `[x]`. The first-class representation is TipTap task-list items (`<li data-type="taskItem" data-checked="...">`), so item order and checked-state roundtrip cleanly.

## Deciding what to work on

**Green-light indicators** (go ahead, in Auto mode, without asking):
- Pure frontend UX change scoped to one or two files
- A single endpoint addition whose shape is obvious from existing patterns
- A bug or rough-edge fix with a clear root cause
- Items you've already finished in past sessions that weren't checked off — just tick them
- Chores / cleanup / minor polish that can't regress other features

**Red-light indicators** (surface to Daniel, don't silently start):
- Deployment or infra (Telegram bot hosting, CI, prod merges, dev/prod sync)
- Design-heavy redesigns (dark mode, mobile bottom sheets, full component rewrites)
- Anything that touches prompt engineering / memory-retrieval behavior — easy to regress chat quality
- Destructive migrations (dropping tables, mass-renaming columns) — CLAUDE.md forbids schema changes without flagging
- Items phrased as brainstorms or open questions ("figure out a way to…", "we should think about…")
- Items that interact with third-party auth, iMessage, Claude desktop config, etc.

When in doubt, lean RED. Daniel prefers fewer silent wins over a surprise change to sensitive surfaces.

## Implementation loop

For each item you decide to take:

1. **Announce** the item in one short line before touching code: "Picking up: <item text>". This lets Daniel interrupt if he disagrees.
2. **Implement** it. Prefer editing existing files; follow existing patterns in the codebase (Zustand stores, `apiFetch` helpers, startup column migrations).
3. **Validate** before checking off:
   - `cd frontend && npx tsc --noEmit` (zero errors required)
   - `source venv/bin/activate && python -c "from app.main import app; print('OK')"` if the backend was touched
   - If UI: call it out — say you couldn't click through without Daniel testing in the browser.
4. **Check it off** with `mcp__gooni__check_task(match="<distinctive substring>", note_id=56)`. Use enough of the item text that the substring match is unambiguous.
5. **Move on** to the next green-light item. Stop after two or three items per turn unless Daniel asks for more, so each change is reviewable.

## What "already done" looks like

Some backlog items describe work that has already shipped (Daniel writes items ahead of time and sometimes after). Before implementing, check the codebase for existing behavior:

- If the feature already exists, check the item off with a one-line note in your response ("already in `<file>:<line>`, checked off").
- Do not re-implement or "polish" something that already works unless Daniel explicitly asks.

## Interaction with other skills

- Substantive exchanges about which items to pick / skip still route through `log-prompt`. This skill handles the doing; the deciding rationale, if discussion-worthy, still gets logged.
- When a backlog item expands into a real feature discussion, stop this skill, talk it through with Daniel, and add whatever was decided to `docs/TODO.md` or a new note rather than forcing it through.

## Anti-patterns

- Don't bulk-check multiple items at the end of a turn if you didn't actually implement them — the check mark is load-bearing for Daniel's mental model.
- Don't rewrite or "reorganize" the backlog note contents. Only toggle checkmarks; leave text verbatim.
- Don't invent items. If the backlog is empty or all items are red-light, say so and stop.
- Don't treat `docs/TODO.md` or the dashboard `TodoItem` table as the same queue — they're not.
