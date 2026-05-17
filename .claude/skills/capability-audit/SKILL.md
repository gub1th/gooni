---
description: Audit Gooni's `capability_facets` table against the current codebase state and propose facet edits. Use when Daniel says "audit capabilities", "/capability-audit", "check capabilities", or after a PR that touches `app/tools/`, `app/services/messaging/`, `app/main.py` routes, or anything that would shift Gooni's mechanical-functional surface area. The boot-time scan auto-handles `mechanical` facets (tools, routes, channels); this skill handles the layers it CAN'T derive — `functional` (composed capabilities), `behavioral` (emergent patterns), and `architectural` (model/runtime/identity). Output is a proposed-diff table for Daniel to approve before any writes.
---

# /capability-audit

Read-only inspect → propose → apply (after Daniel OK). Never writes silently.

## Goal

Keep Gooni's self-knowledge truthful as the codebase evolves. The `boot_scan` covers `mechanical` facets automatically. This skill closes the remaining gap:

- **Functional facets** — "I can do X for you" — composed from one-or-more mechanical facets. Need human or LLM synthesis; a refactor that splits one tool into three doesn't auto-update the functional layer.
- **Behavioral facets** — emergent patterns the codebase doesn't grep for (style, defaults, failure modes). Auto-promoted from reflection clusters, but PR-time audits can pre-emptively flag obvious shifts.
- **Architectural facets** — model + runtime + memory shape. Rarely changes but absolutely needs to be honest when it does.

## Inputs

1. **Current code diff.** Compare `HEAD` against `origin/main`:
   ```bash
   git diff origin/main...HEAD --stat
   git diff origin/main...HEAD -- app/tools/ app/services/messaging/ app/main.py app/services/orchestrator.py app/services/memory_service.py app/services/capability_service.py
   ```
   Focus on additions/deletions of registered tools, route declarations, channel impls, model wiring, prompt assembly.

2. **Current capability inventory.** Pull via the MCP tool:
   ```
   mcp__gooni__read_capability_facets(layer="")
   ```
   (Layer empty = all user-visible layers; pass `"functional"` etc. to filter.)

## Audit loop

For each change in the diff:

1. **Classify** which layer it might shift:
   - Tool added/removed → `mechanical` (boot scan handles) + possible `functional` ripple (composed capability shifts).
   - Route added/removed → `mechanical` (boot scan handles) + possible `functional` ripple.
   - Orchestrator / prompt assembly edited → `behavioral` or `architectural` shift.
   - Model/embedding wiring changed → `architectural`.
   - New `Reflection`-style services → `architectural` ("I can self-evaluate").

2. **Cross-reference** against current `facet_text` for that layer. Is the existing description still true? Is anything new missing?

3. **Draft an upsert** as a row in the proposed-diff table (see Output below). Don't apply yet.

## Output format (BEFORE writes)

Render a Markdown table to chat:

```
| Action  | facet_key                       | layer        | proposed facet_text                          | reason                          |
|---------|---------------------------------|--------------|----------------------------------------------|---------------------------------|
| update  | functional.web_search           | functional   | I can search the open web via the search... | tool description changed in PR   |
| create  | architectural.self_reflection   | architectural| I run a per-turn Reflexion loop after every… | new reflexion_service.py added   |
| status  | tool.deprecated_tool            | mechanical   | (set status='removed')                       | tool no longer registered        |
```

Then ask: **"Apply? (y / edit / skip)"**

## Apply

After Daniel says "yes" (or replies with their edits), call:

```
mcp__gooni__update_capability_facet(
    facet_key="functional.web_search",
    facet_text="…approved text…",
    layer="functional",   # required only on create
    status="claimed",     # optional
)
```

once per row. Skip silently any row Daniel rejected.

After applies, re-fetch via `read_capability_facets` and confirm the diff matches what was proposed. Report any discrepancies.

## Red lines

- **Never** propose a facet edit you can't back with a specific file:line change in the diff.
- **Never** invent behavioral facets here. Those come from reflection clustering inside the running app. If you have a hunch ("Gooni feels passive"), surface it as a backlog item via `mcp__gooni__add_backlog_item`, not as a behavioral facet write.
- **Never** edit `mechanical` facets that the boot scan owns (`tool.*`, `route.*`, `channel.*`) — the boot scan will overwrite you on next restart. Only touch mechanical to flip `status` on something temporarily known-broken.
- If the diff is large (>20 files) or touches schema migrations, summarize first and ask Daniel which sub-area to focus the audit on.

## Why this skill exists

Daniel asked: "how do we even make our capability inventory? it is def through the codebase. but how do we efficiently update capabilities everytime the codebase changes." The boot scan covers the deterministic half. This skill is the agentic half — semantic descriptions composed of multiple primitives can't be derived by static scan, so a Claude Code agent reads the diff and proposes the human-curated layers. Together with runtime telemetry + reflection clustering, no single code change can leave the inventory silently wrong.
