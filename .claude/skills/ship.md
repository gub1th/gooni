---
description: Wrap up the current dev session — run pre-commit validation, commit, push, open a PR on GitHub, and log a session note in Gooni's Dev space via the MCP. Trigger on "ship it", "wrap this up", "commit + PR + log the session", "end of session", and similar phrasings. This skill is Gooni-specific and assumes the backend is running on http://localhost:8000.
---

# Ship skill

Run these four steps in order. If any step fails, **stop and report** — don't plow through or improvise around failures.

## 1. Pre-commit validation

Before committing anything, run the checks CLAUDE.md requires:

```bash
cd frontend && npx tsc --noEmit
source venv/bin/activate && python -c "from app.main import app; print('backend OK')"
```

Both must return zero errors. If either fails, surface the error and stop.

## 2. Commit

- `git status` + `git diff --stat HEAD` to see what's uncommitted.
- `git log --oneline -5` to match the repo's commit-message style (terse lowercase titles like `add X` / `fix Y`).
- Stage files **by name**, not with `git add -A` (avoid accidentally committing `.env`, secrets, or build artifacts).
- Write a commit message with a one-line title + bullet body covering *why* the changes were made, not just *what*.
- Include the standard `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Pass the message via HEREDOC to preserve formatting.

Never `--amend` an already-pushed commit. If a pre-commit hook fails, fix the root cause and create a new commit.

## 3. Push + PR

- Branch: `git branch --show-current`. Refuse to continue if it's `main`.
- Push with `-u origin <branch>`.
- Check `command -v gh`:
  - **If `gh` is installed**: open the PR with `gh pr create --base main --head <branch>` using `--title` and `--body` (HEREDOC). Body format:
    ```markdown
    ## Summary
    <bullet list of what changed and why>

    ## Test plan
    - [ ] <concrete thing a reviewer should click/run>
    ```
  - **If `gh` is missing**: print the browser URL `https://github.com/<owner>/<repo>/pull/new/<branch>` (parse owner/repo from `git remote get-url origin`) and hand Daniel a copy-pasteable title and body.

Never force-push. Never push to `main` directly.

## 4. Log a session note in Gooni's Dev space

Use the Gooni MCP tools to record what shipped, so future sessions have context.

**Find the Dev space:**
- Call `mcp__gooni__list_spaces()` to get the numeric ID for the "Dev" space.

**Find or create the session note:**
- Call `mcp__gooni__list_notes("dev")` and scan titles for one matching the current branch name, e.g. `Session: feat/xxx`.
- **Exists** → call `mcp__gooni__edit_note(id, content=<updated HTML>)` with a new dated section appended *below* the prior entries (don't overwrite history).
- **Missing** → create one with a direct backend POST (the `add_note` MCP tool is hardcoded to General, so it can't be used here):
  ```bash
  curl -s -X POST http://localhost:8000/spaces/<dev_id>/notes \
    -H "Content-Type: application/json" \
    -d @/tmp/session-note.json
  ```

**Content format — TipTap HTML, NOT plain text.** Plain text with `\n` newlines collapses into one unreadable wall. Use:
- `<h2>` / `<h3>` for section headers
- `<p>` for paragraphs
- `<ul><li><p>...</p></li></ul>` for bullet lists (note the inner `<p>`)
- `<code>` for inline code, `<pre><code>` for code blocks
- `<strong>`, `<em>` for emphasis

**Structure each session entry as:**

```
<h2>Session: <date> — <branch></h2>
<h3>What shipped</h3>
<ul>...</ul>
<h3>Lessons</h3>
<ul>...</ul>
<h3>Open follow-ups</h3>
<ul>...</ul>
<h3>Git</h3>
<p>PR: <a href="...">...</a> · commit: <code>&lt;sha&gt;</code></p>
```

Keep it concrete. Reference specific files / line numbers / tool names. Future-Daniel should be able to pick up cold.

## End-of-skill summary

After all four steps succeed, give Daniel a one-paragraph summary:
- commit SHA (short)
- PR URL
- session note URL (`http://localhost:5173` → Dev space → the note)

Nothing else. Stop there.
