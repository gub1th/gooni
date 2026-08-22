from .fetch_url import FetchUrlTool
from .web_search import WebSearchTool
from .note_tools import (
    SearchNotesTool,
    AddNoteTool,
    FindNoteTool,
    ReadNoteTool,
    ListRecentNotesTool,
)
from .promise_tools import ListPromisesTool
from .trackable_tools import ReadTrackableTool, LogTrackableEntryTool
from .calendar_tools import (
    CreateCalendarEventTool,
    CheckCalendarFreeBusyTool,
    ListUpcomingEventsTool,
    UpdateCalendarEventTool,
    DeleteCalendarEventTool,
)

# Chat tool registry. Promise writes are router-driven (glow/complete);
# trackable logging is an explicit tool since the fitness auto-writer was cut.
#
# `save_memory` and `request_feature` were REMOVED — they were the only two
# tools the extractor already wrote, so a memory or a feature request could
# land by either path on the same turn. That overlap is what the two-writers
# problem actually is, and it is why `write_ledger` has to reconcile a router
# capture against a tool call before the verify rail can judge a claim.
#
# The classes stay (`SaveMemoryTool`, `RequestFeatureTool`) — MCP and tests
# still reference them, and un-registering is the reversible half. What is
# gone is their presence in the CHAT loop.
#
# Deliberately KEPT: add_note, the calendar writes, and log_trackable_entry.
# Those have NO extractor equivalent, so removing them would be capability
# loss, not deduplication. Two writers still exist because of them — this
# narrows the overlap, it does not eliminate the ledger.
registry = [
    # Web
    FetchUrlTool(),
    WebSearchTool(),
    # Notes
    SearchNotesTool(),
    AddNoteTool(),
    FindNoteTool(),
    ReadNoteTool(),
    ListRecentNotesTool(),
    # Promises (read-only — router owns the writes) + trackables (read + explicit log)
    ListPromisesTool(),
    ReadTrackableTool(),
    LogTrackableEntryTool(),
    # Feature requests (tagged Notes since Slice 6)
    # Calendar
    CreateCalendarEventTool(),
    CheckCalendarFreeBusyTool(),
    ListUpcomingEventsTool(),
    UpdateCalendarEventTool(),
    DeleteCalendarEventTool(),
]
tool_map = {t.name: t for t in registry}
