---
description: Seed a half-written draft Gooni note so Daniel sees it in the Drafts sidebar next session and is nudged to finish + publish it. Trigger when an idea crystallizes mid-conversation, after a design discussion worth writing up, after a PR merge with real takeaways, end-of-session reflection, or explicit /seed-draft / /draft / /takeaway. Goal = move thoughts toward written + public output, not just track work.
---

# Seed-draft skill

Drops a stub note into Daniel's Drafts sidebar so an unfinished thought has a visible home. The Drafts surface is the trigger that brings him back to write more — left in chat or memory, the thread dies. Once finished, Daniel may flip the note to `is_public` and ship it on his portfolio. The skill exists to grease that pipeline.

## When to fire

- A design discussion just produced a substantive take Daniel hasn't written down yet
- A PR with real takeaways merged (mirror of the CLAUDE.md "one-line takeaway per merged PR" rule)
- End-of-session: something is worth finishing later, but Daniel needs to dip
- Daniel explicitly asks: "/seed-draft", "/draft", "/takeaway", "leave me a stub", "draft a note for that"
- An idea pattern-matched "Daniel said something publishable" — opinions, distinctions, original framings

## When NOT to fire

- Trivial PRs (typo, version bump) where there's nothing to finish
- Pure work-tracking notes ("did X, then Y") — those belong in `add_memory`, not as draft prose
- Daniel says "skip", "no draft", "don't seed"
- A draft for the exact same thread already exists (search before creating; update if it does)
- Conversation went in circles without producing a take

## How to fire

1. Pick the angle. What's the *take* worth finishing? Strip context-dependent framing — write a title future-Daniel will recognize cold. Examples:
   - PR-merge case: `PR #<N> takeaway: <topic>`
   - Design-talk case: `<topic>: <distinct angle>` (e.g. `Memory v2: subtle vs concrete is the right axis`)
   - Reflection case: `Session note — <YYYY-MM-DD>` only as last resort; specific is better

2. Write a **brief** "what shipped / what we figured out" summary. 1–3 sentences. Resist the urge to write the whole post — the goal is to nudge, not to do Daniel's writing for him. Then leave a section heading + empty paragraph for him.

   Body skeleton (TipTap HTML):
   ```html
   <p><em>What shipped / what we figured out:</em> <one to three sentences with a hook for future-Daniel></p>
   <h3>This is what Daniel says he learned</h3>
   <p></p>
   ```

   For non-PR drafts, the second heading can shift to fit:
   - `<h3>The take</h3>` — for opinion / framing posts
   - `<h3>What I'd write publicly</h3>` — when the goal is a portfolio piece
   - `<h3>Loose ends</h3>` — when the thought isn't done yet

3. Create via `mcp__gooni__add_note` with `space_name="General"`. Drafts live in General by default; the sidebar surfaces them globally.

4. Mark `is_draft: true` via `PATCH /notes/{id}`. The MCP `add_note` tool does not yet support a draft flag — backlog #216 (extend MCP add_note for is_draft) tracks this.

   ```bash
   curl -s -X PATCH http://localhost:8000/notes/<id> \
     -H "Content-Type: application/json" \
     -d '{"is_draft": true}'
   ```

5. If the PATCH fails (backend HTTP down), the note exists as a regular note. Note the deferred draft flip in the final report. Don't retry in a loop.

6. One-line confirmation: `seeded draft #<id> — your turn to finish`. No fanfare.

## Anti-patterns

- Writing the takeaway yourself. Daniel has to reach. Anything you put in the body should be scaffolding — context he forgot, not the conclusion.
- Multi-paragraph "summary" sections. Three sentences max. The longer the summary, the lower his odds of writing more.
- Skipping the draft flag. Without it, the stub gets buried in All Notes and dies. The Drafts sidebar is the load-bearing surface for "this is unfinished — finish it."
- Seeding the same thread twice. Use `mcp__gooni__find_note` or search first; if a draft for this topic exists, edit it rather than spawn a duplicate.
- Generic titles like "Notes from today". Pick the angle — specific titles re-engage future-Daniel; generic ones don't.
