---
description: Persist current session state to memory before Daniel runs /clear, so the next session can resume cold without losing context. Trigger on "/clear-persist", "/persist-clear", "/clear-prep", "bout to clear", "save state before clear", "summarize before clear", "dump session state". DIFFERENT from /wrap-session — /wrap pushes + merges code; /clear-persist saves session context (decisions, open threads, half-shipped state) into a memory file that auto-loads next session.
---

# Clear-persist skill

Daniel is about to invoke `/clear` (wipes conversation context). The next session starts blank — no task list, no scrollback, no in-flight reasoning. This skill saves a structured handoff into the project memory system so the next session can pick up exactly where this one left off.

## When to fire

- Daniel says: "/clear-persist", "/persist-clear", "/clear-prep", "bout to clear", "summarize before clear", "save state before /clear", "dump session state"
- Daniel signals he's ending the session but NOT shipping yet (work mid-flight)

## When NOT to fire

- Session work is fully shipped and merged — use `/wrap-session` instead
- Pure question/answer session with no shippable artifacts or open threads — nothing to persist
- Trivial session (one typo fix) — overhead not worth it

## Difference from /wrap-session

- `/wrap-session` = push branch, open PR, merge, update backlog, drop takeaway note. **Ships code.**
- `/clear-persist` = write a handoff memory file so the next session can resume mid-flight. **Saves context, doesn't ship.**

If work is shippable, prefer `/wrap-session`. If work is mid-flight (broken tests, half-implemented feature, pending decisions), `/clear-persist`.

## Steps

### 1. Audit session state

In parallel:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat
```

Also pull `TaskList` to see what tasks are in progress / pending.

### 2. Compose handoff memory

Write to `~/.claude/projects/-Users-danielgunawan-Desktop-projects-gooni/memory/session_handoff.md` (single file, overwrites prior — handoff is single-current). Use this exact frontmatter shape:

```markdown
---
name: session-handoff
description: Most recent session's mid-flight state — what shipped, what's outstanding, where to resume. Written by /clear-persist. Stale once the next session wraps; replace or delete then.
metadata:
  type: project
---

# Session handoff — <YYYY-MM-DD>

## What shipped this session
- <one bullet per landed change, file paths if helpful>

## What's mid-flight (NOT shipped)
- <feature/bug>: <one-line status, what's done, what's left>
- <next concrete action to take>

## Key decisions made
- <decision>: <one-line why>

## Open threads / questions
- <thing Daniel was thinking about, didn't conclude>

## Diagnostics still on the table
- <eval result, error, perf number — anything quantitative that matters>

## Where to resume
- Branch: `<branch-name>`
- File(s) to open first: `<paths>`
- Next concrete step: <one sentence>
```

### 3. Update MEMORY.md index

Add (or update) one line under `## Project`:

```
- [Session handoff — <date>](session_handoff.md) — mid-flight state from <date>; resume here next session
```

If a previous `session_handoff` entry already exists, replace its description with the new date so Daniel can tell it was refreshed.

### 4. Stage but don't commit

If uncommitted work needs to survive `/clear` AND should not be lost to a stash, leave it dirty in the worktree — `/clear` clears Claude context, not git state. Surface dirty files in the handoff `## What's mid-flight` section so the next session knows to pick them up.

If files are noisy (`.scratch/`, accidental edits), suggest stashing with a clear name before `/clear`:

```bash
git stash push -m "session-end <date> — <topic>" <paths>
```

### 5. Final report to Daniel

One terse block. Show:
- Path to the handoff memory file
- Number of bullets in each section (lets Daniel sanity-check)
- Any dirty worktree files he should commit/stash before clearing
- "Safe to /clear" line if no blockers

## Anti-patterns

- Writing the handoff to MEMORY.md itself — MEMORY.md is an index, not content. Always a separate file.
- Spamming multiple memory files per session. ONE handoff file, overwritten each clear-persist call.
- Including code blocks longer than ~10 lines. Reference files + line numbers instead.
- Re-saving info that's already in other memory files (user profile, feedback rules). Only NEW state from this session.
- Conflating with `/wrap-session`. If work is shippable, push it instead. Handoff is for genuinely mid-flight state.
- Burying the next concrete action. The "Where to resume → Next concrete step" line is the most-read line of the file. Make it explicit.
