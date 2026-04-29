from typing import Optional

from pydantic import BaseModel


class ChatRequest(BaseModel):
    content: str
    image_url: Optional[str] = None
    entry_content: Optional[str] = ""
    model: Optional[str] = None
    # "plan" switches Gooni into the structured planning behavior
    # (see PLAN_MODE_PROMPT). Anything else / absent = normal chat.
    mode: Optional[str] = None
