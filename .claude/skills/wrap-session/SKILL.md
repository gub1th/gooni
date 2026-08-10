---
description: Wrap up the current session — push the active branch, open a PR, squash-merge if the work is basically finished, close the tracking Promises, drop a draft takeaway note. Trigger on "/wrap-session", "/wrap", "/ship", "let's wrap up", "merge what we have", "i need to dip — close this out", or similar end-of-session asks.
---

# Wrap-session skill

End-of-session shut-down. Daniel needs to dip; you need to leave the branch, the tracking Promises, and the takeaway in a state he can resume from cold next session without piecing things back together.

## When to fire

- Daniel says: "/wrap", "/ship", "wrap up", "i need to dip", "close this out", "merge what we have", "let's call it"
- Daniel explicitly says the current work is done and wants it landed before he stops

## When NOT to fire

- Mid-design conversations where no code has been committed yet (nothing to ship)
- Branches with broken/half-finished code (validation should fail anyway — surface it, don't push)
- When Daniel hasn't reviewed your last change yet (CLAUDE.md "Verify understanding before pushing" — recap first, even in /wrap)

## Steps

Run sequentially. Bail loudly if any step fails — don't paper over.

### 1. Audit what would ship

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
```

Look for:
- Are commits present on this branch? If zero, abort — nothing to wrap.
- Any uncommitted dirty files? Either they belong in the wrap (commit) or they don't (stash with a clear name). Don't auto-commit unrelated WIP.
- Any half-finished commits (TODO comments, console.logs, conflict markers)? Flag, don't ship.

### 2. Recap before push

Per CLAUDE.md global rule. 3–6 lines:
- What changed
- Why it works (one paragraph)
- One non-obvious thing Daniel should be able to explain back

Wait for "got it" / "yes" / "go". Skip recap only if the work is truly trivial (typo, bump). The recap is the load-bearing safety check — Daniel often catches a missed scope here.

### 3. Validate

```bash
cd frontend && npx tsc --noEmit
# Backend smoke (from main project venv if worktree has none):
python -c "from app.main import app; print('OK')"
```

If type errors or import failures: bail. Tell Daniel what broke. Don't push broken code at session-end — that's the worst time to land regressions.

### 4. Push + open PR

```bash
git push -u origin <branch>
gh pr create --title "<conventional-commit title>" --body "$(cat <<'EOF'
## Summary
- <bullets>

## Why
<short paragraph if non-obvious>

## Test plan
- [ ] <bullet>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Title under 70 chars. Body section uses real conventional-commit prefix from the commit history.

### 5. Merge

```bash
gh pr merge <num> --squash --delete-branch
```

If `--delete-branch` fails because main is checked out in another worktree, retry without `--delete-branch`. The remote branch deletes; local cleanup later.

If CI is configured and gate-failing, use `--auto` to merge once green; otherwise direct squash.

### 6. Close the tracking Promises

There is no backlog board. `ListItem` and `/list-items` died in the v2 nuke
(`e8b3c6d9f2a7`); per CLAUDE.md, non-trivial dev work now lives as **Promises**.
This step used to `curl -X PATCH http://localhost:8000/list-items/<id>` — a route
that has 404'd since the nuke, under a "don't block the wrap if HTTP is down"
instruction that made the 404 read as a transient outage forever.

For each Promise the PR closes, use the MCP tool:

```
mcp__gooni__set_promise_state(promise_id=<id>, state="kept")
```

Find the ids first with `mcp__gooni__list_promises(state="active")` if you don't
already have them from the session. Multiple Promises in one PR: N calls.

The PR URL has nowhere to live on a Promise — it goes in the step-7 takeaway
note, which is where PR provenance belongs now.

If the MCP connector is unavailable, the same edit over REST is
`PATCH /promises/{id}` with `{"state": "kept"}` (Bearer-authed like every route).
**A 404 from either is a bug to report, not an outage to wait out** — say so in
the final report rather than deferring it silently.

### 7. Draft takeaway note

Invoke the `seed-draft` skill (or inline its logic):
- Title: `PR #<N> takeaway: <topic>` for PR-driven wraps; for design-driven wraps, use a topic-specific angle
- Body = brief "what shipped / what we figured out" + empty heading for Daniel to fill
- Mark `is_draft: true` so it surfaces in the Drafts sidebar next session

Skip for trivial PRs or wraps that produced nothing worth finishing.

### 8. Final report

One terse block:
- PR URL + merged status
- Promises closed / left open (and why)
- Takeaway note id
- Anything left dirty in the worktree (untracked files, stashes worth knowing)
- Branch local cleanup hint if the remote branch was auto-deleted

## Anti-patterns

- Pushing without recap. Daniel often catches a scope miss here. Don't skip.
- Force-pushing or amending. CLAUDE.md global rules — never do without explicit ask.
- Auto-committing untracked files Daniel didn't reference. Stash them, name the stash, surface it in the final report.
- "Done" report when something was deferred. Always be explicit about what didn't land.
- Merging while validation failed. Surface the failure, let Daniel decide.
