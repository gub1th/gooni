---
description: Persist the current substantive user prompt to Gooni's "Claude Code" space (space id 6) via direct backend POST. Use when the user raises a technical/design question worth keeping, writes a thoughtful multi-paragraph ask, or explicitly asks "what do you think / am I spouting nonsense" — anything worth re-reading later. SKIP for trivial prompts ("push", "commit", "undo", "yes", "ok", "fix it"), tool-loading messages, and single-command utterances. This skill is Gooni-specific and assumes the backend is running on http://localhost:8000.
---

# Log prompt skill

Silent, behind-the-scenes. No chat narration beyond a one-line mention at the end of the turn if relevant ("logged as note #N in Claude Code").

## When to log
- Multi-paragraph thoughtful requests with technical / design reasoning
- Explicit tradeoff questions ("which approach is better?", "am I spouting nonsense?", "what do you think?")
- Architecture debates, engineering critiques, UX design discussions
- Prompts where Daniel is reasoning out loud and wants a conversation

## When NOT to log
- Single-word / single-command prompts (`push`, `commit`, `undo`, `yes`, `no`, `ok`, `merge it`)
- Short bug reports with a screenshot and minimal text
- Follow-up confirmations on previous answers ("looks good", "go ahead")
- Tool-loading replies or system-reminder-only turns

## How to log

1. **Decide** if the prompt is substantive (see above). If no, stop — do nothing.
2. **Compose** a title (`Prompt — <short phrase>`, under 70 chars) and a TipTap HTML body.
   - **Body structure**:
     - `<p><strong>Daniel's prompt (YYYY-MM-DD):</strong></p>`
     - `<blockquote><p>...prompt verbatim...</p></blockquote>`
     - Optional: `<h3>Answer</h3>` / `<h3>Key points</h3>` / `<ul><li><p>...</p></li></ul>` summarizing the response that actually shipped.
   - **Content MUST be TipTap HTML** — `<p>`, `<h3>`, `<ul><li><p>...</p></li></ul>`, `<blockquote>`, `<strong>`, `<em>`, `<code>`. Plain text with `\n` collapses into one wall.
3. **POST via curl** — the `mcp__gooni__add_note` MCP tool is hardcoded to General and cannot target other spaces:

   ```bash
   cat > /tmp/claude-code-note.json <<'EOF'
   {
     "title": "Prompt — <short phrase>",
     "content": "<p><strong>Daniel's prompt (YYYY-MM-DD):</strong></p><blockquote><p>...</p></blockquote>..."
   }
   EOF
   curl -s -X POST http://localhost:8000/spaces/6/notes \
     -H "Content-Type: application/json" \
     -d @/tmp/claude-code-note.json
   ```

4. **Log position**: do this AFTER formulating your response but BEFORE finalizing — so the note reflects what actually ships. One note per turn, never duplicate.

5. **Fail gracefully**: if the backend is unreachable (connection refused, 404 on the space), drop the log silently — do NOT surface the failure to Daniel unless he explicitly asks.

## Space assumptions
- Space id **6** is the "Claude Code" space. If `mcp__gooni__list_spaces` shows a different id for it, use that instead.
- If the Claude Code space doesn't exist, create it first:
  ```bash
  curl -s -X POST http://localhost:8000/spaces \
    -H "Content-Type: application/json" \
    -d '{"name": "Claude Code", "emoji": "🤖"}'
  ```
  Then use the returned `id`.

## Anti-patterns
- Don't announce every log in chat. Silent is the default.
- Don't log the user's follow-up ("yes build it") — the substantive turn was the earlier one.
- Don't reformulate or summarize the prompt in the blockquote — copy verbatim. The summary belongs in the `<h3>Answer</h3>` section below.
- Don't log meta-instructions about the logging system itself (unless they're substantive design decisions, not commands).
