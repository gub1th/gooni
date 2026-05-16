"""Chat-surface tool for Gooni to update its own capability facets mid-turn.

Use case: Daniel says "you actually can do web search, you connected it last
week" — Gooni recognizes its self-knowledge is stale and calls this tool to
flip a facet's status or rewrite its facet_text. The MCP server exposes the
same operation for Claude Code, but having it in the chat tool registry lets
the orchestrator-side LLM update facets without leaving the conversation.

Non-destructive: no DELETE path. status='removed' is the closest thing, and
even that's reserved for the boot-scan source. Manual chat updates can flip
between claimed/verified/unverified/broken.
"""

from .base import BaseTool


class UpdateCapabilityFacetTool(BaseTool):
    name = "update_capability_facet"
    description = (
        "Update Gooni's own capability inventory when self-knowledge is wrong. "
        "Call when Daniel corrects you about what you can/can't do, or when "
        "you realize a facet (in the 'Who I am right now' block) is stale. "
        "Provide `facet_key` (e.g. 'tool.add_note', 'functional.web_search') "
        "and at least one of: `facet_text` (new description), `status` "
        "('claimed'|'verified'|'unverified'|'broken'). Creates the facet if "
        "it doesn't exist; layer must be supplied for create."
    )
    parameters = {
        "type": "object",
        "properties": {
            "facet_key": {
                "type": "string",
                "description": "Stable slug. Existing facets: tool.*, route.*, channel.*. New facets: functional.* / behavioral.* / architectural.*.",
            },
            "facet_text": {
                "type": "string",
                "description": "Updated short description of what this capability is. Required for create; optional for update.",
            },
            "status": {
                "type": "string",
                "enum": ["claimed", "verified", "unverified", "broken"],
                "description": "Flip the facet's status.",
            },
            "layer": {
                "type": "string",
                "enum": ["mechanical", "functional", "behavioral", "architectural"],
                "description": "Required only when creating a brand-new facet.",
            },
        },
        "required": ["facet_key"],
    }

    def execute(
        self,
        db=None,
        facet_key: str = "",
        facet_text: str | None = None,
        status: str | None = None,
        layer: str | None = None,
        **kwargs,
    ) -> str:
        from ..db.models import CapabilityFacet

        facet_key = (facet_key or "").strip()
        if not facet_key:
            return "update_capability_facet: facet_key required"
        if db is None:
            return "update_capability_facet: no db session"

        row = (
            db.query(CapabilityFacet)
            .filter(CapabilityFacet.facet_key == facet_key)
            .one_or_none()
        )
        if row is None:
            if not facet_text or not layer:
                return (
                    f"update_capability_facet: facet '{facet_key}' doesn't exist; "
                    "provide both facet_text and layer to create it."
                )
            row = CapabilityFacet(
                facet_key=facet_key,
                layer=layer,
                facet_text=facet_text.strip(),
                status=status or "claimed",
                source="chat_tool_update",
            )
            db.add(row)
            db.commit()
            return f"created facet '{facet_key}' (layer={row.layer}, status={row.status})."

        changed = []
        if facet_text and facet_text.strip():
            row.facet_text = facet_text.strip()
            changed.append("text")
        if status:
            row.status = status
            changed.append(f"status={status}")
        if layer:
            row.layer = layer
            changed.append(f"layer={layer}")
        if not changed:
            return f"update_capability_facet: no changes specified for '{facet_key}'."
        row.source = "chat_tool_update"
        db.commit()
        return f"updated facet '{facet_key}': {', '.join(changed)}."
