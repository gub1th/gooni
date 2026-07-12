
// Exported so non-fetch consumers (iframe src, image previews, etc) can
// build absolute URLs to the backend instead of relative paths that fall
// through the Vite SPA index.html and return HTML.
export const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export function getStoredToken(): string | null {
  return localStorage.getItem("gooni_token");
}

function setStoredToken(token: string) {
  localStorage.setItem("gooni_token", token);
}


export async function login(password: string): Promise<void> {
  const res = await fetch(`${BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error("Wrong password");
  const { token } = await res.json();
  setStoredToken(token);
}

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getStoredToken();
  if (token) {
    init.headers = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` };
  }
  return fetch(url, init);
}

// ── Spaces ─────────────────────────────────────────────────────────────────────

// ── Notes ──────────────────────────────────────────────────────────────────────

export interface NoteClassifySignals {
  feature_requests: { title: string; list_item_id: number }[];
  memory_count: number;
  memory_types: string[];
  classified_at: string;
}

export interface ApiNote {
  id: number;
  title: string | null;
  // Null on list-view responses (`/spaces/:id/notes`, `/notes/recent`,
  // `/notes/pinned`, `/notes/drafts`, dashboard.recent_notes,
  // `/notes/:id/related`, `/notes/:id/children`). The editor calls
  // `GET /notes/:id` to fetch the full body on demand.
  content: string | null;
  // Plain-text excerpt (≤240 chars, <img> stripped) populated on list
  // responses so NotesList rows can render previews without the full body.
  excerpt?: string | null;
  // First external <img src="https://..."/> from the note body. Inline
  // base64 images are excluded — list endpoints never ship those.
  thumb_src?: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  is_public: boolean;
  is_pinned: boolean;
  is_draft: boolean;
  // Snapshot of what classify_note routed for this note's most recent save.
  // Mirrors the chat-side `signals` payload — drives the "Routed:" disclosure
  // under the title so Daniel sees memory writes + backlog items as soon as
  // the async classifier finishes. Null until classify has run.
  classify_signals?: NoteClassifySignals | null;
  // Set when this note was extracted out of a parent via the BubbleMenu
  // "↗ Extract to new note" action. The parent keeps a NoteLink chip in
  // place of the selection; `excerpt_anchor` is the chip label.
  parent_note_id?: number | null;
  excerpt_anchor?: string | null;
  // Free-form labels (lowercase, ≤60 chars each, deduped server-side).
  // Always present in responses — empty array when no tags.
  tags: string[];
  // Notion-style optional note icon. Either a single emoji (e.g. "📝")
  // OR a lucide reference of shape "lucide:<name>" matching SpaceIcon
  // encoding. Null = no icon (default).
  icon?: string | null;
  // Distinct visitors that hit /public/notes/{id}. Only present on the
  // single-note GET (`/notes/{id}`), not on space-list responses — the
  // count requires a per-note Visit query that isn't worth running for
  // every list row.
  unique_viewers?: number;
  // The day a "daily log" note is about (YYYY-MM-DD) — set only for the
  // log-matrix note column. Null for ordinary notes.
  log_date?: string | null;
  // Sticky placement on the ambient home canvas: {x,y} as viewport fractions
  // (0..1) + optional {w,h} px size. Set only for stickies; null otherwise.
  home_pos?: { x: number; y: number; w?: number; h?: number } | null;
}

export type StickyPos = { x: number; y: number; w?: number; h?: number };

// Slice 6: Spaces died — the flat GET /notes list IS the corpus. The
// spaceId param survives for call-site compatibility ("general" = all)
// but is ignored server-side; optional tag filtering happens in the UI.
export async function fetchSpaceNotes(_spaceId: number | "general"): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes`);
  if (!res.ok) throw new Error("Failed to fetch notes");
  return res.json();
}

// Semantic note search — uses the note embeddings + cosine similarity.
// Same backend route the MCP server hits via search_notes; surfaced here
// so the frontend's All-Notes discovery view can reuse it.
export async function searchNotes(query: string, limit = 12): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/mcp/notes/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error("Failed to search notes");
  return res.json();
}

// Title-substring search powering the @-mention note picker. Cheap (no
// embedding), prefix-friendly, recency-ordered. Empty query → recent notes.
export async function searchNoteTitles(query: string, limit = 8): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/search-titles?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error("Failed to search note titles");
  return res.json();
}

export async function fetchRecentNotes(limit = 5): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/recent?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch recent notes");
  return res.json();
}

export async function createNote(
  _spaceId: number | "general",
  init: { title?: string; content?: string; tags?: string[] } = {},
): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(init),
  });
  if (!res.ok) throw new Error("Failed to create note");
  return res.json();
}

export async function updateNote(id: number, title: string, content: string): Promise<ApiNote> {
  // `keepalive` would let this request survive a tab close, but the browser
  // caps keepalive bodies at 64 KiB — a single base64-inlined image blows
  // past that and `fetch` throws "TypeError: Failed to fetch" before the
  // request leaves the page. Drop the flag; on tab-close we lose the
  // in-flight save, but the next edit re-saves the full body anyway.
  const res = await apiFetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) throw new Error("Failed to update note");
  return res.json();
}

export async function touchNote(id: number): Promise<void> {
  // Fire-and-forget — updates last_opened_at for relevancy sorting
  await apiFetch(`${BASE}/notes/${id}/touch`, { method: "POST" });
}

export async function memorizeNote(id: number): Promise<void> {
  // Fire-and-forget — called when leaving a note to extract a memory episode
  await apiFetch(`${BASE}/notes/${id}/memorize`, { method: "POST" });
}

export async function autoTitleNote(id: number): Promise<{ title: string; generated: boolean }> {
  // Asks the backend to generate + persist a short title via gpt-4o-mini.
  // No-op for short notes (returns generated:false).
  const res = await apiFetch(`${BASE}/notes/${id}/auto-title`, { method: "POST" });
  if (!res.ok) throw new Error("auto-title failed");
  return res.json();
}

export async function extractToChildNote(
  parentId: number,
  selectedHtml: string,
  title?: string,
): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/notes/${parentId}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selected_html: selectedHtml, title }),
  });
  if (!res.ok) throw new Error("Failed to extract child note");
  return res.json();
}


export async function embedNote(id: number): Promise<void> {
  try {
    await apiFetch(`${BASE}/notes/${id}/embed`, { method: "POST" });
  } catch {
    // embed is a fire-and-forget side effect; failures are non-fatal
  }
}

export async function fetchNote(id: number): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/notes/${id}`);
  if (!res.ok) throw new Error("Note not found");
  return res.json();
}


export async function fetchNoteMemories(id: number): Promise<ApiMemory[]> {
  try {
    const res = await apiFetch(`${BASE}/notes/${id}/memories?limit=6`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function fetchPinnedNotes(): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/pinned`);
  if (!res.ok) throw new Error("Failed to fetch pinned notes");
  return res.json();
}

export async function fetchDraftNotes(): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/drafts`);
  if (!res.ok) throw new Error("Failed to fetch draft notes");
  return res.json();
}


// ── Google Calendar integration ─────────────────────────────────────────────────

export interface GoogleCalendarStatus {
  configured: boolean;     // env vars set on backend
  connected: boolean;      // user has active token row
  account_email: string | null;
}
export async function fetchCalendarStatus(): Promise<GoogleCalendarStatus> {
  const res = await apiFetch(`${BASE}/auth/google/status`);
  if (!res.ok) throw new Error("Failed to fetch calendar status");
  return res.json();
}
export async function startCalendarOAuth(): Promise<{ authorize_url: string }> {
  const res = await apiFetch(`${BASE}/auth/google/start`);
  if (!res.ok) throw new Error("Calendar OAuth not configured on backend");
  return res.json();
}
export async function disconnectCalendar(): Promise<void> {
  const res = await apiFetch(`${BASE}/auth/google`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to disconnect calendar");
}

// ── Calendar events (widget-facing read/write) ───────────────────────────────
// The backend flattens Google's start.dateTime / start.date union into a single
// `start` string + `all_day` flag (see integrations.py::_serialize_event).

/** Thrown on 401 = OAuth row missing. Widgets catch this to show a connect CTA
 *  instead of a hard error. */
export class CalendarNotConnectedError extends Error {
  constructor() {
    super("Calendar not connected");
    this.name = "CalendarNotConnectedError";
  }
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null;   // ISO dateTime for timed events, YYYY-MM-DD for all-day
  end: string | null;
  all_day: boolean;
  html_link?: string | null;
  description?: string | null;
  location?: string | null;
}

export interface CalendarEventInput {
  summary: string;
  start_iso: string;
  end_iso: string;
  description?: string;
  time_zone?: string;
}

export async function fetchCalendarEvents(startISO: string, endISO: string): Promise<CalendarEvent[]> {
  const res = await apiFetch(
    `${BASE}/calendar/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
  );
  if (res.status === 401) throw new CalendarNotConnectedError();
  if (!res.ok) throw new Error("Failed to fetch calendar events");
  return res.json();
}

export async function createCalendarEvent(input: CalendarEventInput): Promise<CalendarEvent> {
  const res = await apiFetch(`${BASE}/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new CalendarNotConnectedError();
  if (!res.ok) throw new Error("Failed to create calendar event");
  return res.json();
}

export async function updateCalendarEvent(
  id: string,
  patch: Partial<CalendarEventInput>,
): Promise<CalendarEvent> {
  const res = await apiFetch(`${BASE}/calendar/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new CalendarNotConnectedError();
  if (!res.ok) throw new Error("Failed to update calendar event");
  return res.json();
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/calendar/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new CalendarNotConnectedError();
  if (!res.ok) throw new Error("Failed to delete calendar event");
}


// ── GitHub integration ──────────────────────────────────────────────────────

export interface GithubStatus {
  configured: boolean;
  connected: boolean;
  account_email: string | null;   // reused field — holds @login for GitHub
}
export async function fetchGithubStatus(): Promise<GithubStatus> {
  const res = await apiFetch(`${BASE}/auth/github/status`);
  if (!res.ok) throw new Error("Failed to fetch GitHub status");
  return res.json();
}
export async function startGithubOAuth(): Promise<{ authorize_url: string }> {
  const res = await apiFetch(`${BASE}/auth/github/start`);
  if (!res.ok) throw new Error("GitHub OAuth not configured on backend");
  return res.json();
}
export async function disconnectGithub(): Promise<void> {
  const res = await apiFetch(`${BASE}/auth/github`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to disconnect GitHub");
}

// ── Whoop integration ──────────────────────────────────────────────────────

export interface WhoopStatus {
  configured: boolean;
  connected: boolean;
  account_email: string | null;
}
export async function fetchWhoopStatus(): Promise<WhoopStatus> {
  const res = await apiFetch(`${BASE}/auth/whoop/status`);
  if (!res.ok) throw new Error("Failed to fetch Whoop status");
  return res.json();
}
export async function startWhoopOAuth(): Promise<{ authorize_url: string }> {
  const res = await apiFetch(`${BASE}/auth/whoop/start`);
  if (!res.ok) throw new Error("Whoop OAuth not configured on backend");
  return res.json();
}
export async function disconnectWhoop(): Promise<void> {
  const res = await apiFetch(`${BASE}/auth/whoop`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to disconnect Whoop");
}

export interface WhoopToday {
  date: string | null;
  recovery_score: number | null;
  hrv_rmssd_ms: number | null;
  resting_hr: number | null;
  strain: number | null;
  sleep_minutes: number | null;
  sleep_performance_pct: number | null;
  updated_at: string | null;
  source_updated_at: string | null;
}
export async function fetchWhoopToday(refresh = false): Promise<WhoopToday> {
  const url = `${BASE}/whoop/today${refresh ? "?refresh=1" : ""}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Whoop today fetch failed: ${msg || res.status}`);
  }
  return res.json();
}

export interface LeetcodeToday {
  available: boolean;
  username?: string;
  snapshot_date?: string | null;
  streak?: number | null;
  total_active_days?: number | null;
  today_count?: number | null;
  week_count?: number | null;
  total_solved?: number | null;
  easy_solved?: number | null;
  medium_solved?: number | null;
  hard_solved?: number | null;
  ranking?: number | null;
  // {unix_ts_string: count}, last 365d
  calendar?: Record<string, number>;
  updated_at?: string | null;
}
export async function fetchLeetcodeToday(refresh = false): Promise<LeetcodeToday> {
  const url = `${BASE}/leetcode/today${refresh ? "?refresh=1" : ""}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`LeetCode today fetch failed: ${msg || res.status}`);
  }
  return res.json();
}

export async function cleanupEmptyNotes(): Promise<{ deleted: number; ids: number[] }> {
  const res = await apiFetch(`${BASE}/notes/cleanup`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to clean up notes");
  return res.json();
}

export async function patchNote(
  id: number,
  patch: { is_public?: boolean; is_pinned?: boolean; is_public_pinned?: boolean; is_draft?: boolean; title?: string; content?: string; tags?: string[]; icon?: string | null },
): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to patch note");
  return res.json();
}

export async function deleteNote(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/notes/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete note");
}

// ── Public portfolio ────────────────────────────────────────────────────────────

export interface PublicNote {
  id: number;
  title: string | null;
  space_name: string | null;
  excerpt: string;
  updated_at: string;
  read_time_minutes: number;
  is_public_pinned?: boolean;
}

export interface PublicNoteDetail {
  id: number;
  title: string | null;
  content: string | null;
  space_name: string | null;
  created_at: string;
  updated_at: string;
  unique_viewers: number;
}

export async function fetchPublicNote(id: number): Promise<PublicNoteDetail> {
  const res = await apiFetch(`${BASE}/public/notes/${id}`);
  if (!res.ok) throw new Error("Not found");
  return res.json();
}

export async function fetchPublicNotes(): Promise<PublicNote[]> {
  const res = await apiFetch(`${BASE}/public/notes`);
  if (!res.ok) throw new Error("Failed to fetch public notes");
  return res.json();
}

export interface PublicProfilePayload {
  bio: string | null;
  avatar_url: string | null;
  note_count: number;
  last_active: string | null;
}

export async function fetchPublicProfile(): Promise<PublicProfilePayload> {
  const res = await apiFetch(`${BASE}/public/profile`);
  if (!res.ok) throw new Error("Failed to fetch public profile");
  return res.json();
}

export async function fetchPublicVisitCount(): Promise<{ unique_visitors: number }> {
  const res = await apiFetch(`${BASE}/public/visits/count`);
  if (!res.ok) throw new Error("Failed to fetch visit count");
  return res.json();
}

// Public MCP-config surface — scraped server-side from .mcp.json + the MCP
// server source at request time. Powers the /public/mcp page.
export interface PublicMcpServer {
  name: string;
  command: string;
  script: string | null;
  env_keys: string[];
}
export interface PublicMcpToolParam {
  name: string;
  required: boolean;
}
export interface PublicMcpTool {
  name: string;
  params: PublicMcpToolParam[];
  description: string;
}
export interface PublicMcpConfig {
  servers: PublicMcpServer[];
  tools: PublicMcpTool[];
}

export async function fetchPublicMcpConfig(): Promise<PublicMcpConfig> {
  const res = await apiFetch(`${BASE}/public/mcp`);
  if (!res.ok) throw new Error("Failed to fetch MCP config");
  return res.json();
}


export async function updatePublicProfile(bio: string): Promise<void> {
  const res = await apiFetch(`${BASE}/public/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bio }),
  });
  if (!res.ok) throw new Error("Failed to update public profile");
}

// PATCH the avatar URL only. Pass null to clear (resets to the goofy default
// in the comments avatar renderer).
export async function updatePublicAvatar(avatarUrl: string | null): Promise<void> {
  const res = await apiFetch(`${BASE}/public/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_url: avatarUrl }),
  });
  if (!res.ok) throw new Error("Failed to update profile avatar");
}

export async function uploadAvatarImage(file: File): Promise<{ url: string; key: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`${BASE}/uploads/image`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`Avatar upload failed (${res.status})`);
  return res.json();
}

// ── Dashboard ──────────────────────────────────────────────────────────────────


export interface ApiConversation {
  id: number;
  title: string | null;
  source: string;
  created_at: string;
  last_message_at: string | null;
}

export interface MessageTraceStep {
  type:
    | "intention"
    | "memory_recall"
    | "tool_call"
    | "reply"
    | "pipeline_version"
    | "master_prompt"
    | "extracted_signals"
    | "memories_applied"
    | "plan"
    | "verify";
  label: string;
  detail?: string | null;
  args?: Record<string, unknown> | null;
  // Canonical TraceBuilder shape — duplicated from the legacy keys above so
  // both the chat MessageBubble (legacy) and the eval UI (canonical) read
  // from the same trace JSON without a second round trip.
  key?: string;
  input?: unknown;
  output?: unknown;
  meta?: Record<string, unknown> | null;
}

// Slice 3 glow: parsed promise-create drafts annotated onto a user
// message by the extractor. status drives the log view's dot lifecycle.
export interface SignalPreviewSignal {
  kind: string;
  utterance: string | null;
  summary: string | null;
  cadence: PromiseCadence;
  cadence_target: number | null;
  due_date: string | null;
  due_hint: string | null;
  is_important: boolean;
  parent_hint: string | null;
}

export interface SignalPreview {
  signals: SignalPreviewSignal[];
  // extract_failed = the extractor died on this turn (LLM error/truncated
  // JSON) — captures were lost; the log renders a retry affordance.
  status: "pending" | "promoted" | "dismissed" | "extract_failed";
  promise_ids: number[];
}

export interface ApiMessage {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  is_feedback?: boolean;
  feedback_for_message_id?: number | null;
  trace?: MessageTraceStep[] | null;
  has_actionable_signal?: boolean;
  signal_preview?: SignalPreview | null;
}

// Flat log row — ApiMessage + the conversation's source badge.
export interface LogMessage extends ApiMessage {
  source: string;
}

export async function fetchMessageLog(opts: { limit?: number; beforeId?: number } = {}): Promise<LogMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.beforeId) params.set("before_id", String(opts.beforeId));
  const qs = params.toString();
  const res = await apiFetch(`${BASE}/messages/log${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch message log");
  return res.json();
}

// Full per-turn processing trace (orchestrator steps + tool-call audit +
// paired user utterance + post-turn reflexion), keyed to the assistant
// message. Powers the ambient recent-chat ribbon's audit panel.
export interface TurnTrace {
  message: {
    id: number;
    conversation_id: number;
    role: string;
    content: string;
    created_at: string;
    source: string;
  };
  user_message: { id: number; content: string; created_at: string } | null;
  trace: MessageTraceStep[];
  tool_calls: EvalToolCall[];
  reflection: EvalReflectionInline | null;
}

export async function fetchTurnTrace(messageId: number): Promise<TurnTrace> {
  const res = await apiFetch(`${BASE}/messages/${messageId}/trace`);
  if (!res.ok) throw new Error("Failed to fetch turn trace");
  return res.json();
}

export async function promoteMessage(messageId: number): Promise<{ message: LogMessage; promises: ApiPromise[] }> {
  const res = await apiFetch(`${BASE}/messages/${messageId}/promote`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to promote message");
  return res.json();
}

export async function undoPromoteMessage(messageId: number): Promise<{ message: LogMessage }> {
  const res = await apiFetch(`${BASE}/messages/${messageId}/undo-promote`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to undo promote");
  return res.json();
}

export async function dismissMessageGlow(messageId: number): Promise<{ message: LogMessage }> {
  const res = await apiFetch(`${BASE}/messages/${messageId}/dismiss-glow`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to dismiss glow");
  return res.json();
}

export async function reextractMessage(messageId: number): Promise<{ message: LogMessage }> {
  // Retry extraction on an extract_failed message — re-runs the signal
  // pipeline server-side; glow re-lands if commitments are found.
  const res = await apiFetch(`${BASE}/messages/${messageId}/reextract`, { method: "POST" });
  if (!res.ok) throw new Error("retry failed — extractor may still be down");
  return res.json();
}

// ── Ambient overlay (Slice 4) ───────────────────────────────────────────

export interface OverlayHorizonEntry extends ApiPromise {
  reason: "overdue" | "due_soon" | "important";
}

export interface OverlayTrackableEntry {
  id: number;
  name: string;
  kind: string;
  unit: string | null;
  target: number | null;
  is_important: boolean;
  value: number | boolean | Record<string, unknown> | null;
  status: "pending" | "logged" | "met" | "missed";
  reason: string;
}

export interface OverlayData {
  action_horizon: OverlayHorizonEntry[];
  trackables_today: OverlayTrackableEntry[];
  anchor: { id: number; title: string | null; excerpt: string | null } | null;
  whoop_select: { id: number; name: string; unit: string | null; value: unknown }[];
}

export async function fetchOverlay(): Promise<OverlayData> {
  const res = await apiFetch(`${BASE}/overlay`);
  if (!res.ok) throw new Error("Failed to fetch overlay");
  return res.json();
}

export async function setOverlayAnchorNote(noteId: number | null): Promise<void> {
  const res = await apiFetch(`${BASE}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overlay_anchor_note_id: noteId }),
  });
  if (!res.ok) throw new Error("Failed to set anchor note");
}

export async function fetchConversations(): Promise<ApiConversation[]> {
  const res = await apiFetch(`${BASE}/feed`);
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

// ── Trackables (ambient log surface) ─────────────────────────────────────────
export type TrackableKind = "boolean" | "numeric" | "json";

export interface Trackable {
  id: number;
  name: string;
  kind: TrackableKind;
  unit: string | null;
  cadence: string | null;
  target: number | null;
  is_important: boolean;
  agg: string | null;
  schema_hint: unknown;
  source: string;
  parent_promise_id: number | null;
}

export interface TrackableDay {
  date: string;
  value: boolean | number | Record<string, unknown> | null;
  // Optional freeform tag riding on the day (value_json.label) — e.g. an
  // exercise day tagged "push"/"legs". Only booleans carry one today.
  label?: string | null;
  entry_count: number;
}

export async function fetchTrackables(): Promise<Trackable[]> {
  const res = await apiFetch(`${BASE}/trackables`);
  if (!res.ok) throw new Error("Failed to fetch trackables");
  return res.json();
}

// Per-day pivot, newest-first, gap-filled — days[0] is `end` (today by
// default). Pass `end` (YYYY-MM-DD) to fetch an older window — the log
// matrix pages backwards for infinite scroll.
export async function fetchTrackableDays(
  id: number,
  days = 7,
  end?: string,
): Promise<{ trackable: Trackable; days: TrackableDay[] }> {
  const q = new URLSearchParams({ days: String(days), fill: "true" });
  if (end) q.set("end", end);
  const res = await apiFetch(`${BASE}/trackables/${id}/entries?${q.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch trackable days");
  return res.json();
}

// ── Daily-log notes (the log-matrix note column) ─────────────────────────────
// Per-day freeform "what happened" notes, backed by the Note primitive
// (log_date + `daily` tag) so they're searchable + feed memory like any note.

// Notes whose log_date lands in the [end-(days-1), end] window (sparse).
export async function fetchDailyNotes(days: number, end?: string): Promise<ApiNote[]> {
  const q = new URLSearchParams({ days: String(days) });
  if (end) q.set("end", end);
  const res = await apiFetch(`${BASE}/notes/daily?${q.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch daily notes");
  return res.json();
}

// Upsert the daily note for a date. Empty content deletes it (cell-clear).
export async function upsertDailyNote(
  date: string,
  content: string,
): Promise<ApiNote | { cleared: boolean }> {
  const res = await apiFetch(`${BASE}/notes/daily/${date}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to save daily note");
  return res.json();
}

// ── Sticky notes (ambient home canvas) ───────────────────────────────────────
// Free-floating notes parked on the home void, backed by the Note primitive
// (home_pos + `sticky` tag).

export async function fetchStickyNotes(): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/sticky`);
  if (!res.ok) throw new Error("Failed to fetch sticky notes");
  return res.json();
}

export async function createStickyNote(
  content: string,
  pos: StickyPos,
): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, tags: ["sticky"], home_pos: pos, is_draft: false }),
  });
  if (!res.ok) throw new Error("Failed to create sticky note");
  return res.json();
}

export async function updateStickyNote(
  id: number,
  patch: { content?: string; home_pos?: StickyPos | null },
): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update sticky note");
  return res.json();
}

// Log one entry. replace=true = cell-edit (collapse the day to this value).
export async function logTrackable(
  id: number,
  // date (YYYY-MM-DD) optional → omit for today; pass to edit a historical cell
  body: {
    value_boolean?: boolean;
    value_numeric?: number;
    // Freeform sidecar (e.g. {label: "push"}) — tags a boolean entry.
    value_json?: Record<string, unknown>;
    replace?: boolean;
    date?: string;
  },
): Promise<{ cleared: boolean }> {
  const res = await apiFetch(`${BASE}/trackables/${id}/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, source: "manual" }),
  });
  if (!res.ok) throw new Error("Failed to log trackable");
  return res.json();
}

export async function createTrackable(body: {
  name: string;
  kind?: TrackableKind;
  unit?: string;
  target?: number;
}): Promise<Trackable> {
  const res = await apiFetch(`${BASE}/trackables`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to create trackable");
  return res.json();
}

export async function createConversation(content?: string): Promise<ApiConversation> {
  const res = await apiFetch(`${BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content ?? "" }),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

// Signal summary returned from the unified extractor in the orchestrator.
// Drives the chat-side router visualization so Daniel sees what the turn
// was classified as (tone correction, feature request, memory) without
// reading the raw debug payload.
export interface RouterSignals {
  tone_corrections: { rule: string; evidence?: string; anti_pattern?: string }[];
  feature_requests: { title: string; why: string }[];
  memory_count: number;
}

export async function sendConversationMessage(
  convId: number,
  content: string,
  noteContent?: string,
  model?: string,
  imageUrl?: string,
): Promise<{ messages: ApiMessage[]; intention: string; tools_used: string[]; signals?: RouterSignals }> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent, model, image_url: imageUrl }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

// ── Streaming chat event types ───────────────────────────────────────────────

export type ChatStreamEvent =
  | { type: "stage"; stage: string; label: string }
  | { type: "tool_start"; id: number | null; tool_name: string; args: Record<string, unknown> }
  | {
      type: "tool_done";
      id: number | null;
      tool_name: string;
      status: "done" | "failed";
      error: string | null;
    }
  | {
      type: "done";
      messages: ApiMessage[];
      intention: string;
      tools_used: string[];
      signals?: RouterSignals;
    }
  | { type: "error"; message: string };

// SSE consumer for `/conversations/{id}/messages/stream`. EventSource is
// GET-only — we need POST + JSON body, so we use fetch + manual chunk
// parsing of `response.body`. Each `data: <json>\n\n` frame is decoded
// and passed to `onEvent`. Heartbeat frames (`:` prefix) are ignored.
export async function sendConversationMessageStream(
  convId: number,
  content: string,
  noteContent: string | undefined,
  model: string | undefined,
  imageUrl: string | undefined,
  onEvent: (evt: ChatStreamEvent) => void,
): Promise<void> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent, model, image_url: imageUrl }),
  });
  if (!res.ok || !res.body) throw new Error(`Stream failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Drain complete frames from
    // the buffer; leave any trailing partial frame for the next iteration.
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith(":")) continue; // heartbeat
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      try {
        const evt = JSON.parse(payload) as ChatStreamEvent;
        onEvent(evt);
      } catch (e) {
        console.error("Bad SSE frame:", payload, e);
      }
    }
  }
}

export async function fetchConversationMessages(convId: number): Promise<ApiMessage[]> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`);
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

// ── Eval run (live prod) ──────────────────────────────────────────────────────

export type EvalRunEvent =
  | { type: "status"; message: string }
  | { type: "line"; data: string }
  | { type: "done"; exit_code: number }
  | { type: "error"; message: string };

// Triggers POST /eval/run-prod-snapshot. SSE-streams per-line stdout. Same
// fetch + manual chunk-parse pattern as sendConversationMessageStream.
export async function runProdSnapshotEval(
  onEvent: (evt: EvalRunEvent) => void,
): Promise<void> {
  const res = await apiFetch(`${BASE}/eval/run-prod-snapshot`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    if (res.status === 409) throw new Error("Another eval is already running");
    throw new Error(`Eval stream failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith(":")) continue;
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const evt = JSON.parse(dataLine.slice(6)) as EvalRunEvent;
        onEvent(evt);
      } catch (e) {
        console.error("Bad eval SSE frame:", dataLine, e);
      }
    }
  }
}

// ── Memories ──────────────────────────────────────────────────────────────────

export type MemoryType = "preference" | "goal" | "fact" | "routine" | "constraint" | "episode";

export interface ApiMemory {
  id: number;
  type: MemoryType;
  key: string | null;
  content: string;
  confidence: number;
  is_active: boolean;
  superseded_by: number | null;
  focus_id: number | null;
  retrieval_count: number;
  last_retrieved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function fetchMemories(opts: {
  type?: MemoryType;
  q?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<{ total: number; memories: ApiMemory[] }> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.q) params.set("q", opts.q);
  if (opts.includeInactive) params.set("include_inactive", "true");
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const res = await apiFetch(`${BASE}/memories?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch memories");
  return res.json();
}

export async function fetchMemoryStats(): Promise<{ total: number; by_type: Record<string, number> }> {
  const res = await apiFetch(`${BASE}/memories/stats`);
  if (!res.ok) throw new Error("Failed to fetch memory stats");
  return res.json();
}

export async function deleteMemory(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/memories/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete memory");
}

export async function patchMemory(id: number, content: string): Promise<void> {
  const res = await apiFetch(`${BASE}/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to update memory");
}

// ── Chat audit ────────────────────────────────────────────────────────────────

export interface ChatAuditFeedback {
  id: number;
  content: string;
  created_at: string | null;
}

export interface ChatAuditEntry {
  id: number;
  conversation_id: number;
  conversation_title: string | null;
  conversation_source: string | null;
  content: string;
  created_at: string | null;
  feedback: ChatAuditFeedback | null;
}

export interface ChatAuditActiveRule {
  memory_id: number;
  rule: string;
  created_at: string | null;
}

export interface ChatAuditResponse {
  total: number;
  entries: ChatAuditEntry[];
  active_rules: ChatAuditActiveRule[];
}

export async function fetchChatAudit(opts: {
  hasFeedbackOnly?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<ChatAuditResponse> {
  const params = new URLSearchParams();
  if (opts.hasFeedbackOnly) params.set("has_feedback_only", "true");
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const res = await apiFetch(`${BASE}/chat-audit?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch chat audit");
  return res.json();
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AppSettings {
  // Legacy field name — the app-wide canonical timezone (IANA).
  nudge_tz: string;
}

export async function fetchSettings(): Promise<AppSettings> {
  const res = await apiFetch(`${BASE}/settings`);
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const res = await apiFetch(`${BASE}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to update settings");
  }
  return res.json();
}

// ── Eval loop ────────────────────────────────────────────────────────────────

export type EvalSource = "web" | "telegram" | "whatsapp" | "imessage";
export type EvalStatus = "not_yet" | "pending" | "done";

export interface EvalSegmentSummary {
  id: number;
  conversation_id: number;
  source: EvalSource | string;
  title: string | null;
  start_message_id: number;
  end_message_id: number;
  last_message_at: string | null;
  message_count: number;
  eval_status: EvalStatus;
  overall_rating: number | null;
  overall_comment: string | null;
  dispatched_to_cc_at: string | null;
  dispatched_note_id: number | null;
  preview: string | null;
  flag_count: number;
  // True when last_message_at < 30 min ago. Derived server-side so the
  // FE can render a "currently active" pulsing dot without polling time.
  is_active?: boolean;
  // Sum of chat-call cost (USD) across all assistant messages in segment.
  // Underestimates by ~$0.001-0.002 per turn (excludes extract/reflect/
  // plan/verify sub-calls — those don't yet stamp usage onto Message.trace).
  cost_usd?: number | null;
}

export interface EvalSegmentList {
  segments: EvalSegmentSummary[];
  total: number;
}

export interface EvalStepFeedback {
  id: number;
  step_key: string;
  step_index: number;
  rating: 1 | 2 | 3;
  comment: string | null;
  created_at: string | null;
}

export interface EvalMessageRating {
  id: number;
  // null when the row exists purely to anchor a reviewer comment with no
  // thumbs picked yet — see PUT /eval/.../rating which accepts rating=null
  // as long as the comment is non-empty.
  rating: 1 | 2 | 3 | null;
  comment: string | null;
  updated_at: string | null;
}

export interface EvalToolCall {
  id: number;
  tool_name: string;
  status: "running" | "done" | "failed";
  args_json: string | null;
  result_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface EvalReflectionInline {
  id: number;
  severity: number;
  user_critique_present: boolean;
  critique_summary: string | null;
  action_vs_described: string;
  gap_exposed: string | null;
  proposed_self_fix: string | null;
  model: string;
  created_at: string | null;
}

export interface EvalMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string | null;
  is_feedback: boolean;
  feedback_for_message_id: number | null;
  trace: MessageTraceStep[] | null;
  step_feedback: EvalStepFeedback[];
  rating: EvalMessageRating | null;
  tool_calls: EvalToolCall[];
  reflection: EvalReflectionInline | null;
}

export interface EvalSegmentFull {
  segment: EvalSegmentSummary;
  messages: EvalMessage[];
}

export interface EvalToolLegendEntry {
  key: string;
  name: string;
  description: string;
}

export async function listEvalSegments(params: {
  sources?: string[];
  statuses?: string[];
  hasFlag?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<EvalSegmentList> {
  const q = new URLSearchParams();
  if (params.sources?.length) q.set("sources", params.sources.join(","));
  if (params.statuses?.length) q.set("statuses", params.statuses.join(","));
  if (params.hasFlag) q.set("has_flag", "true");
  if (params.search) q.set("search", params.search);
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.offset != null) q.set("offset", String(params.offset));
  const res = await apiFetch(`${BASE}/eval/segments?${q.toString()}`);
  if (!res.ok) throw new Error("Failed to list eval segments");
  return res.json();
}

export async function fetchEvalSegmentFull(id: number): Promise<EvalSegmentFull> {
  const res = await apiFetch(`${BASE}/eval/segments/${id}/full`);
  if (!res.ok) throw new Error("Failed to fetch eval segment");
  return res.json();
}

export async function postEvalFeedback(payload: {
  segment_id: number;
  message_id: number;
  step_key: string;
  step_index: number;
  rating: 1 | 2 | 3;
  comment?: string | null;
}): Promise<{ id: number; ok: boolean }> {
  const res = await apiFetch(`${BASE}/eval/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to post eval feedback");
  return res.json();
}


export async function putMessageRating(
  segmentId: number,
  messageId: number,
  payload: { rating: 1 | 2 | 3 | null; comment?: string | null }
): Promise<EvalMessageRating & { message_id: number; segment_eval_status: EvalStatus }> {
  const res = await apiFetch(
    `${BASE}/eval/segments/${segmentId}/messages/${messageId}/rating`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error("Failed to save message rating");
  return res.json();
}

export async function deleteMessageRating(messageId: number): Promise<void> {
  const res = await apiFetch(`${BASE}/eval/messages/${messageId}/rating`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error("Failed to delete rating");
}

export async function patchEvalSummary(
  id: number,
  body: { eval_status?: EvalStatus; overall_rating?: number | null; overall_comment?: string | null }
): Promise<{ id: number; eval_status: EvalStatus; overall_rating: number | null; overall_comment: string | null }> {
  const res = await apiFetch(`${BASE}/eval/segments/${id}/summary`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to update eval summary");
  return res.json();
}

export async function dispatchEvalToCc(
  id: number
): Promise<{ ok: boolean; note_id: number; backlog_list_id: number; dispatched_to_cc_at: string }> {
  const res = await apiFetch(`${BASE}/eval/segments/${id}/dispatch-to-cc`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to dispatch eval to Claude Code");
  return res.json();
}

export async function fetchEvalToolsLegend(): Promise<{ tools: EvalToolLegendEntry[] }> {
  const res = await apiFetch(`${BASE}/eval/tools-legend`);
  if (!res.ok) throw new Error("Failed to fetch tools legend");
  return res.json();
}

// ── Image uploads ─────────────────────────────────────────────────────────────

export type ImageUploadResult =
  | { kind: "url"; url: string; key: string }
  // Returned when the backend reports R2 isn't configured (503). Caller is
  // expected to fall back to inline base64 so dev/un-provisioned envs still
  // work; once R2 is wired in prod, this branch should never fire there.
  | { kind: "fallback"; reason: string }
  | { kind: "error"; status: number; message: string };

// ── Local draft cache (offline / OOM fallback) ───────────────────────────────
//
// When a save PATCH fails (network error, server 502 mid-OOM, etc) we still
// have the editor's current title+content client-side. Stash it under this
// localStorage key so the next load of the same note can detect leftover
// unsaved work, hydrate the editor with it, and retry the save.

const NOTE_DRAFT_PREFIX = "gooni_note_draft_v1:";

export interface LocalNoteDraft {
  noteId: number;
  title: string;
  content: string;
  savedAt: number; // epoch ms
}

export function saveLocalNoteDraft(noteId: number, title: string, content: string) {
  try {
    const payload: LocalNoteDraft = { noteId, title, content, savedAt: Date.now() };
    localStorage.setItem(NOTE_DRAFT_PREFIX + noteId, JSON.stringify(payload));
  } catch {
    // localStorage full / private mode / disabled — best-effort.
  }
}

export function readLocalNoteDraft(noteId: number): LocalNoteDraft | null {
  try {
    const raw = localStorage.getItem(NOTE_DRAFT_PREFIX + noteId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalNoteDraft;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.noteId !== noteId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLocalNoteDraft(noteId: number) {
  try {
    localStorage.removeItem(NOTE_DRAFT_PREFIX + noteId);
  } catch {
    // ignore
  }
}


export async function uploadImage(file: File): Promise<ImageUploadResult> {
  const form = new FormData();
  form.append("file", file, file.name || "image");
  const res = await apiFetch(`${BASE}/uploads/image`, { method: "POST", body: form });
  if (res.ok) {
    const data = await res.json();
    return { kind: "url", url: data.url, key: data.key };
  }
  if (res.status === 503) {
    return { kind: "fallback", reason: "R2 not configured" };
  }
  let message = res.statusText || "upload failed";
  try {
    const body = await res.json();
    if (body?.detail) message = String(body.detail);
  } catch {
    // body wasn't JSON — keep status text
  }
  return { kind: "error", status: res.status, message };
}

// ── Promises ────────────────────────────────────────────────────────────

// G3.1 lifecycle: promises land `active` on create, then resolve to
// `kept` or `broken`. The legacy proposed/pending lock-in split + the
// `abandoned` terminal were removed — service + routes only accept these
// three. Keep this in sync with promise_service.transition.
export type PromiseState = "active" | "kept" | "broken";

// Ambient-loop v2: one primitive expresses one-shot todos AND recurring
// habits AND standing rules. Keep in sync with promise_service.VALID_CADENCES.
export type PromiseCadence =
  | "once"
  | "daily"
  | "n_per_week"
  | "permanent_do"
  | "permanent_never";

export interface ApiPromise {
  id: number;
  utterance: string;
  summary: string | null;
  state: PromiseState;
  cadence: PromiseCadence;
  cadence_target: number | null;
  is_important: boolean;
  parent_promise_id: number | null;
  inferred_due: string | null;
  slip_count: number;
  resolved_at: string | null;
  source_message_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function fetchPromises(opts: { state?: PromiseState; limit?: number } = {}): Promise<ApiPromise[]> {
  const params = new URLSearchParams();
  if (opts.state) params.set("state", opts.state);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await apiFetch(`${BASE}/promises${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch promises");
  return res.json();
}

export async function patchPromiseState(id: number, state: PromiseState): Promise<ApiPromise> {
  return patchPromise(id, { state });
}

// Full promise edit — any subset of {text, due, state, is_important,
// cadence, cadence_target}. `due` is an ISO datetime string (UTC, "…Z")
// or null to clear. Backend applies non-state edits then the state
// transition in one round-trip (see promises router).
export async function patchPromise(
  id: number,
  patch: {
    text?: string;
    due?: string | null;
    state?: PromiseState;
    is_important?: boolean;
    cadence?: PromiseCadence;
    cadence_target?: number | null;
  },
): Promise<ApiPromise> {
  const res = await apiFetch(`${BASE}/promises/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update promise");
  return res.json();
}

// Manual create — promises normally land via chat utterances, but the
// drawer lets Daniel add one directly. Backend runs the same
// promise_service.create path (complexity classify, embed, focus edge,
// habit auto-spawn), just without a source message.
export async function createPromise(text: string): Promise<ApiPromise> {
  const res = await apiFetch(`${BASE}/promises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("Failed to create promise");
  return res.json();
}

// ── Open Graph link previews ──────────────────────────────────────────────

export interface OgMetadata {
  url: string;
  title: string;
  description: string | null;
  image: string | null;
  site_name: string | null;
  fetch_error?: string;
}

export async function fetchOgMetadata(url: string): Promise<OgMetadata> {
  const res = await apiFetch(`${BASE}/uploads/og?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error("Failed to fetch link preview");
  return res.json();
}

// ── File attachments ──────────────────────────────────────────────────────

export interface FileUploadOk {
  kind: "url";
  url: string;
  key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  attachment_id: number | null;
}

export type FileUploadResult =
  | FileUploadOk
  | { kind: "fallback"; reason: string }
  | { kind: "error"; status: number; message: string };

export async function uploadAttachment(
  file: File,
  noteId?: number,
  todoId?: number,
): Promise<FileUploadResult> {
  const form = new FormData();
  form.append("file", file, file.name || "attachment");
  if (todoId != null) form.append("todo_id", String(todoId));
  else if (noteId != null) form.append("note_id", String(noteId));
  const res = await apiFetch(`${BASE}/uploads/file`, { method: "POST", body: form });
  if (res.ok) {
    const data = await res.json();
    return {
      kind: "url",
      url: data.url,
      key: data.key,
      filename: data.filename,
      mime_type: data.mime_type,
      size_bytes: data.size_bytes,
      attachment_id: data.attachment_id ?? null,
    };
  }
  if (res.status === 503) {
    return { kind: "fallback", reason: "R2 not configured" };
  }
  let message = res.statusText || "upload failed";
  try {
    const body = await res.json();
    if (body?.detail) message = String(body.detail);
  } catch {
    // body wasn't JSON — keep status text
  }
  return { kind: "error", status: res.status, message };
}


// ── Habits (daily binary trackers) ─────────────────────────────────────


// ── Gooni health (Build mode) ──────────────────────────────────────────


export type ReflectionAction = "acted" | "described" | "mixed" | "na";

export interface ApiReflection {
  id: number;
  message_id: number;
  conversation_id: number;
  user_critique_present: boolean;
  critique_summary: string | null;
  action_vs_described: ReflectionAction | string;
  gap_exposed: string | null;
  proposed_self_fix: string | null;
  severity: 1 | 2 | 3 | number;
  model: string;
  created_at: string | null;
}

export async function fetchReflections(opts: {
  conversationId?: number;
  messageId?: number;
  severityMin?: number;
  limit?: number;
} = {}): Promise<{ reflections: ApiReflection[] }> {
  const params = new URLSearchParams();
  if (opts.conversationId != null) params.set("conversation_id", String(opts.conversationId));
  if (opts.messageId != null) params.set("message_id", String(opts.messageId));
  if (opts.severityMin != null) params.set("severity_min", String(opts.severityMin));
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await apiFetch(`${BASE}/reflections${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch reflections");
  return res.json();
}

// ── Reactions (Confluence-style emoji on notes + comments) ────────────────
