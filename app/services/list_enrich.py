"""Async venue enrichment for places-shaped lists.

When a user adds something like "Horsefeather" to a list named "date
spots" / "restaurants" / "bars", Gooni fires a one-shot web_search +
LLM-summary in the background and patches the result into the item's
subtitle. The list itself feels less isolated — items show up with
context Daniel didn't have to type.

Design constraints:
  - Opt-in by list name. Only fires when the parent list name matches a
    places-shape regex. Wrong-list fires waste Tavily quota + LLM tokens.
  - Subtitle gate. Only enrich when subtitle is empty — Daniel's manual
    body always wins.
  - Async. Never block the add_item return path. Threading w/ a fresh
    SessionLocal so the caller's session isn't reused cross-thread.
  - Best-effort. Any failure (no API key, network blip, empty result,
    LLM glitch) silently degrades to no-op. The item still exists.
  - Single attempt. No retries — Tavily is paid and a missed enrich is
    a small annoyance; a retry loop on a flaky network would burn
    quota fast.
"""

from __future__ import annotations

import re
import threading

from ..db.database import SessionLocal
from ..db.models import List as ListModel, ListItem
from ..llm.client import llm_client
from ..tools.web_search import WebSearchTool


# Regex that catches the list-name shapes worth web-enriching. Matches
# against the lowercased name. Tuned to common Daniel patterns ("date
# spots", "places to go", "hot list", "restaurants") without firing on
# generic todo / shopping / reading lists.
_PLACES_NAME_RE = re.compile(
    r"\b("
    r"place|places|spot|spots|restaurant|restaurants|bar|bars|venue|venues|"
    r"eat|eats|food|dining|brunch|coffee|cafe|cafes|cocktail|cocktails|"
    r"date\s*(?:spot|night|idea|ideas)?|"
    r"happy\s*hour|patio|rooftop|hot\s*list|to[-\s]?go|hit\s*list"
    r")\b",
    re.IGNORECASE,
)

# Hard cap on subtitle length — keeps the UI clean and protects against a
# verbose LLM summary blowing past the column's natural visual budget.
_SUBTITLE_MAX_CHARS = 200


def _looks_places_shaped(list_name: str | None) -> bool:
    """Lowercased name match against the places-shape regex."""
    return bool(list_name and _PLACES_NAME_RE.search(list_name))


def maybe_enrich_item(item_id: int, list_id: int) -> None:
    """Fire-and-forget kickoff. Validates list shape via a quick read
    session, then spins a daemon thread that owns its own SessionLocal
    for the slow path (web_search + LLM summary + UPDATE).

    Returns immediately so add_item callers don't pay the latency.
    """
    sess = SessionLocal()
    try:
        lst = sess.query(ListModel).filter(ListModel.id == list_id).first()
        if lst is None or not _looks_places_shaped(lst.name):
            return
    finally:
        sess.close()
    threading.Thread(
        target=_run_enrich,
        args=(item_id,),
        daemon=True,
    ).start()


def _run_enrich(item_id: int) -> None:
    """Background body. Re-reads the item in its own session, calls
    Tavily, asks gpt-4o-mini to compress the result into a venue
    blurb, and PATCHes subtitle in place. Any branch can early-return
    quietly — there's no user-facing error surface for this path.
    """
    sess = SessionLocal()
    try:
        item = sess.query(ListItem).filter(ListItem.id == item_id).first()
        if item is None:
            return
        # Daniel's manual body wins. Only enrich blank subtitles so we
        # never overwrite a deliberate one-liner.
        if (item.subtitle or "").strip():
            return
        venue = (item.text or "").strip()
        if not venue:
            return

        try:
            raw = WebSearchTool().execute(
                query=f"{venue} restaurant bar venue review hours location"
            )
        except Exception as e:
            print(f"[list_enrich] web_search error: {e}")
            return
        if not raw or raw.startswith("web_search"):
            # WebSearchTool returns error strings prefixed "web_search"
            # on every failure shape — treat as no-op.
            return

        summary = _summarize_venue(venue, raw)
        if not summary:
            return
        if len(summary) > _SUBTITLE_MAX_CHARS:
            summary = summary[:_SUBTITLE_MAX_CHARS].rstrip() + "…"

        # Re-fetch under the same session before UPDATE in case the item
        # was edited between our two reads — preserves a manual subtitle
        # if Daniel raced us.
        if (item.subtitle or "").strip():
            return
        item.subtitle = summary
        sess.commit()
    except Exception as e:
        print(f"[list_enrich] unexpected error: {e}")
        try:
            sess.rollback()
        except Exception:
            pass
    finally:
        sess.close()


def _summarize_venue(venue: str, raw_search: str) -> str:
    """LLM-compress the Tavily response to a single descriptive line.
    Empty string on any failure — caller treats that as no-enrich.
    """
    prompt = (
        f"You're enriching a list item for Daniel's personal places list. "
        f"He added \"{venue}\". Below are web-search results. Write ONE "
        f"short line (≤25 words) describing what this place is — cuisine "
        f"or vibe, neighbourhood if obvious, what it's known for. No "
        f"greeting, no preface, no quote marks, no link. Lowercase casual, "
        f"like Daniel would write it. If the results don't actually "
        f"describe a real venue, return an empty string.\n\n"
        f"SEARCH:\n{raw_search[:2000]}\n\nONE-LINE:"
    )
    try:
        out = llm_client.generate_simple_completion(
            prompt, max_tokens=80, temperature=0.3, model="gpt-4o-mini",
        )
    except Exception as e:
        print(f"[list_enrich] summary LLM error: {e}")
        return ""
    return (out or "").strip().strip('"').strip("'")
