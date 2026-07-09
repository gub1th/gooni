
// Exported so non-fetch consumers (iframe src, image previews, etc) can
// build absolute URLs to the backend instead of relative paths that fall
// through the Vite SPA index.html and return HTML.
export const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export function getStoredToken(): string | null {
  return localStorage.getItem("gooni_token");
}

export function setStoredToken(token: string) {
  localStorage.setItem("gooni_token", token);
}

export function clearStoredToken() {
  localStorage.removeItem("gooni_token");
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

export interface ApiSpace {
  id: number;
  name: string;
  emoji: string | null;
  is_pinned: boolean;
  // Long-form prose about what this space is for. Renders as the header
  // on the space view. Sanitized at render time, same as note content.
  description: string | null;
  // R2 URL for an optional cover banner image.
  cover_image_url: string | null;
}

export async function fetchSpaces(): Promise<ApiSpace[]> {
  const res = await apiFetch(`${BASE}/spaces`);
  if (!res.ok) throw new Error("Failed to fetch spaces");
  return res.json();
}

export async function createSpace(name: string, emoji?: string): Promise<ApiSpace> {
  const res = await apiFetch(`${BASE}/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, emoji: emoji || null }),
  });
  if (!res.ok) throw new Error("Failed to create space");
  return res.json();
}

export async function updateSpace(id: number, patch: { name?: string; emoji?: string | null; is_pinned?: boolean; description?: string | null; cover_image_url?: string | null }): Promise<ApiSpace> {
  const res = await apiFetch(`${BASE}/spaces/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update space");
  return res.json();
}

export async function deleteSpace(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/spaces/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete space");
}

export interface ApiSpaceStats {
  space_id: number;
  note_count: number;
  last_touched: string | null;
  top_tags: { tag: string; count: number }[];
}

export async function fetchSpaceStats(id: number): Promise<ApiSpaceStats> {
  const res = await apiFetch(`${BASE}/spaces/${id}/stats`);
  if (!res.ok) throw new Error("Failed to fetch space stats");
  return res.json();
}


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
  space_id: number | null;
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
  // Graduation lifecycle. `unprocessed` = captured but uncommitted;
  // `graduated` = spawned a Promise / Todo / Habit / Focus (tracked via
  // derives_from edges); `archived` = manual tombstone. Drives the
  // Unprocessed sidebar view + the synthesizer's source filter.
  status: "unprocessed" | "graduated" | "archived";
  // Notion-style optional note icon. Either a single emoji (e.g. "📝")
  // OR a lucide reference of shape "lucide:<name>" matching SpaceIcon
  // encoding. Null = no icon (default).
  icon?: string | null;
  // Distinct visitors that hit /public/notes/{id}. Only present on the
  // single-note GET (`/notes/{id}`), not on space-list responses — the
  // count requires a per-note Visit query that isn't worth running for
  // every list row.
  unique_viewers?: number;
}

export async function fetchSpaceNotes(spaceId: number | "general"): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/spaces/${spaceId}/notes`);
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
  spaceId: number | "general",
  init: { title?: string; content?: string } = {},
): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/spaces/${spaceId}/notes`, {
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

export async function fetchNoteChildren(parentId: number): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/${parentId}/children`);
  if (!res.ok) throw new Error("Failed to fetch note children");
  return res.json();
}

export async function moveNote(id: number, toSpaceId: string): Promise<ApiNote> {
  const space_id = toSpaceId === "general" ? null : parseInt(toSpaceId);
  const res = await apiFetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space_id }),
  });
  if (!res.ok) throw new Error("Failed to move note");
  return res.json();
}

export interface SpaceSuggestion {
  suggested_space_id: number | null;
  suggested_space_name: string | null;
  suggested_space_emoji: string | null;
}

export async function embedNote(id: number): Promise<SpaceSuggestion> {
  try {
    const res = await apiFetch(`${BASE}/notes/${id}/embed`, { method: "POST" });
    if (!res.ok) return { suggested_space_id: null, suggested_space_name: null, suggested_space_emoji: null };
    return res.json();
  } catch {
    return { suggested_space_id: null, suggested_space_name: null, suggested_space_emoji: null };
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

export interface ApiNoteComment {
  id: number;
  note_id: number;
  author: string;
  content: string;
  created_at: string | null;
}

export async function fetchNoteComments(noteId: number): Promise<ApiNoteComment[]> {
  try {
    const res = await apiFetch(`${BASE}/notes/${noteId}/comments`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function createNoteComment(
  noteId: number,
  content: string,
  author = "daniel",
): Promise<ApiNoteComment> {
  const res = await apiFetch(`${BASE}/notes/${noteId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, author }),
  });
  if (!res.ok) throw new Error("Failed to post comment");
  return res.json();
}

export async function deleteNoteComment(commentId: number): Promise<void> {
  const res = await apiFetch(`${BASE}/comments/${commentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete comment");
}

export async function fetchDraftNotes(): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/drafts`);
  if (!res.ok) throw new Error("Failed to fetch draft notes");
  return res.json();
}

export async function fetchUnprocessedNotes(): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/unprocessed`);
  if (!res.ok) throw new Error("Failed to fetch unprocessed notes");
  return res.json();
}

export interface GraphNode {
  id: number;
  title: string;
  size: number;
  space_id: number | null;
}
export interface GraphEdge {
  from: number;
  to: number;
  weight: number;
}
export async function fetchNotesGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const res = await apiFetch(`${BASE}/notes/graph`);
  if (!res.ok) throw new Error("Failed to fetch notes graph");
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

export interface CalendarEvent {
  id: string;
  html_link: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}
export async function createCalendarEvent(body: {
  summary: string;
  start_iso: string;
  end_iso: string;
  description?: string;
  time_zone?: string;
}): Promise<CalendarEvent> {
  const res = await apiFetch(`${BASE}/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Failed to create event: ${msg || res.status}`);
  }
  return res.json();
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

export interface GithubRepo {
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  pushed_at: string | null;
  tracked: boolean;
}
export async function listGithubRepos(): Promise<GithubRepo[]> {
  const res = await apiFetch(`${BASE}/integrations/github/repos`);
  if (!res.ok) throw new Error(`Failed to list repos (${res.status})`);
  return res.json();
}
export async function trackRepo(owner: string, name: string): Promise<void> {
  const res = await apiFetch(
    `${BASE}/integrations/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error("Failed to track repo");
}
export async function untrackRepo(owner: string, name: string): Promise<void> {
  const res = await apiFetch(
    `${BASE}/integrations/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error("Failed to untrack repo");
}

export interface DevActivityCommit {
  sha: string;
  subject: string;
  body: string;
  html_url: string | null;
  committed_at: string;
}
export interface DevActivityRepo {
  owner: string;
  name: string;
  today?: {
    commits: number;
    additions: number;
    deletions: number;
    files_changed: number;
    subjects: string[];
  };
  recent?: DevActivityCommit[];
  streak_days?: number;
  error?: string;
}
export interface DevActivity {
  configured: boolean;
  connected: boolean;
  repos: DevActivityRepo[];
  aggregate: { streak_days: number; today_commits: number };
  fetched_at?: string | null;
}
export async function fetchDevActivity(refresh = false): Promise<DevActivity> {
  const qs = refresh ? "?refresh=1" : "";
  const res = await apiFetch(`${BASE}/dashboard/dev-activity${qs}`);
  if (!res.ok) throw new Error("Failed to fetch dev activity");
  return res.json();
}

export interface GooniSnapshot {
  day: string;
  taken_at: string | null;
  digest: string;
}
export async function fetchSnapshotToday(): Promise<GooniSnapshot> {
  const res = await apiFetch(`${BASE}/snapshot/today`);
  if (!res.ok) throw new Error("Failed to fetch snapshot");
  return res.json();
}

export async function cleanupEmptyNotes(): Promise<{ deleted: number; ids: number[] }> {
  const res = await apiFetch(`${BASE}/notes/cleanup`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to clean up notes");
  return res.json();
}

export async function patchNote(
  id: number,
  patch: { is_public?: boolean; is_pinned?: boolean; is_public_pinned?: boolean; is_draft?: boolean; title?: string; content?: string; tags?: string[]; status?: "unprocessed" | "graduated" | "archived"; icon?: string | null },
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

export async function fetchPublicNoteComments(id: number): Promise<ApiNoteComment[]> {
  const res = await apiFetch(`${BASE}/public/notes/${id}/comments`);
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

// ── Items (unified focus + todo) ────────────────────────────────────────────
//
// One concept, one table. An item with `endgoal` and no parent renders as a
// focus; a leaf item renders as a todo; anything in between renders as a
// checklist node.

// Status: 'pending' was dropped in the focus-flow redesign — every focus is
// either committed or someday now.
// 'dormant' added by focus-drift (auto-flipped after 3 missed bind
// runs); 'evolved' set by /focuses/{id}/fork. Both are excluded from
// the active binding game on the backend.
export type FocusStatus =
  | "committed"
  | "someday"
  | "dormant"
  | "evolved";
// Pace bucket — Quick (one-off, today) vs Slow burn (multi-day).
export type FocusScale = "quick" | "slow";

export interface ApiItem {
  id: number;
  list_id: number;
  parent_id: number | null;
  text: string;
  subtitle: string | null;
  endgoal: string | null;
  committed: boolean;
  actionable: boolean;
  is_primary: boolean;
  done: boolean;
  // Engagement: 'committed' = active focus, 'someday' = parked (dimmed in list).
  status: FocusStatus | null;
  scale: FocusScale | null;
  // Health gauge 0..100. NULL until Gooni has activity to score it.
  health: number | null;
  // Reporter confidence in the health score, 0..100. Renders neutral when
  // either field is null OR confidence < 35.
  confidence: number | null;
  // Wall-clock window for the focus. Quick focuses default to (now → midnight
  // tonight) on create; slow burn focuses pick their own.
  start_at: string | null;
  end_at: string | null;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  source_note_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ApiItemNode extends ApiItem {
  children: ApiItemNode[];
  progress: { done: number; total: number };
  stale: boolean;
}

export interface ApiItemTree {
  focuses: ApiItemNode[];
  inbox: ApiItemNode[];
  // Totals before pagination — drives the "Load more" affordance.
  // Optional so older client builds talking to the new server still parse.
  total_focuses?: number;
  total_inbox?: number;
  limit?: number;
  offset?: number;
}

export interface ApiTodayItem extends ApiItem {
  parent_chain: string[];
}

export async function fetchItemTree(): Promise<ApiItemTree> {
  // No-arg signature kept stable so react-query's QueryFunction context
  // (which passes a context object) doesn't conflict. For paginated
  // fetches, use `fetchItemTreePage` with explicit limit/offset.
  const res = await apiFetch(`${BASE}/items`);
  if (!res.ok) throw new Error("Failed to fetch items");
  return res.json();
}

export async function fetchItemTreePage(
  limit: number,
  offset = 0,
): Promise<ApiItemTree> {
  const res = await apiFetch(`${BASE}/items?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error("Failed to fetch items");
  return res.json();
}

export async function fetchTodayItems(): Promise<ApiTodayItem[]> {
  const res = await apiFetch(`${BASE}/items/today`);
  if (!res.ok) throw new Error("Failed to fetch today items");
  return res.json();
}

export async function createItem(body: {
  text: string;
  parent_id?: number | null;
  endgoal?: string | null;
  committed?: boolean;
  due_date?: string | null;
  source_note_id?: number | null;
  status?: FocusStatus | null;
  scale?: FocusScale | null;
  is_primary?: boolean;
  health?: number | null;
  confidence?: number | null;
  start_at?: string | null;
  end_at?: string | null;
}): Promise<ApiItem> {
  const res = await apiFetch(`${BASE}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to create item");
  return res.json();
}

export async function updateItem(
  id: number,
  patch: Partial<{
    text: string;
    endgoal: string | null;
    committed: boolean;
    actionable: boolean;
    is_primary: boolean;
    done: boolean;
    due_date: string | null;
    subtitle: string | null;
    sort_order: number;
    parent_id: number | null;
    status: FocusStatus | null;
    scale: FocusScale | null;
    health: number | null;
    confidence: number | null;
    start_at: string | null;
    end_at: string | null;
  }>,
): Promise<ApiItem> {
  const res = await apiFetch(`${BASE}/items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update item");
  return res.json();
}

export async function deleteItem(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/items/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete item");
}

export async function reorderItems(ids: number[]): Promise<void> {
  const res = await apiFetch(`${BASE}/items/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error("Failed to reorder items");
}

// ── Dashboard revamp: dedicated focus + todo tables ────────────────────
//
// After the schema split, focuses and todos no longer ride the legacy
// `list_items` god-table. The /focuses + /todos endpoints below return
// these slimmed shapes — used by the new dashboard FocusCardsRow + the
// TodoList component. ApiItem above is kept for the legacy item tree
// callers until they migrate.

export type TodoState = "not_yet" | "doing" | "done";

export interface ApiTodo {
  id: number;
  text: string;
  subtitle: string | null;
  state: TodoState;
  // Single FK now (legacy M2M `focus_todo_links` was dropped).
  focus_id: number | null;
  // Singleton across the whole todos table. Crowned at the top of the
  // dashboard list, auto-cleared on completion.
  is_primary: boolean;
  due_date: string | null;
  done: boolean;
  completed_at: string | null;
  sort_order: number;
  source_note_id: number | null;
  // G3.5: short inline outcome text captured at close. Null when no
  // outcome was given. Longer outcomes use a Note + `outcome_of` edge.
  closure_note?: string | null;
  // Count of files attached to this todo. Computed in one grouped query on
  // the bundle (GET /todos) — NOT shipped by the single-todo serializer, so
  // it may be undefined right after a create/patch until the bundle refetches.
  attachment_count?: number;
  created_at: string | null;
  updated_at: string | null;
}

// G3.5: per-todo chain lineage summary. Backend computes once for the
// whole bundle so the UI can render Surface C (↗N + "from:" indicators)
// without N+1 chain fetches. parent_text is the parent's text trimmed —
// the UI may truncate further. Only todos with chain links have entries.
export interface TodoChainMeta {
  children_total: number;
  children_done: number;
  parent_id: number | null;
  parent_text: string | null;
}

// Bucketed payload from GET /todos. Frontend renders `primary` as the
// crowned row, `open` below it, and `done_today` in the collapsed
// "Completed" toggle of the Done section.
export interface ApiTodoBundle {
  primary: ApiTodo | null;
  open: ApiTodo[];
  done_today: ApiTodo[];
  // G3.5: map of todo_id → chain metadata. Only present for todos with
  // at least one spawned_from edge (either as src or dst). Absent entries
  // mean the todo has no chain — render no indicator.
  chain_summary?: Record<number, TodoChainMeta>;
}

export interface ApiFocus {
  id: number;
  text: string;
  subtitle: string | null;
  endgoal: string | null;
  committed: boolean;
  done: boolean;
  status: FocusStatus | null;
  scale: FocusScale | null;
  // Auto-assigned palette color (one of 10) used by the focus card's
  // left rail + the dot rendered next to linked todos.
  color: string | null;
  health: number | null;
  confidence: number | null;
  start_at: string | null;
  end_at: string | null;
  completed_at: string | null;
  sort_order: number;
  source_note_id: number | null;
  // Drift / lineage cols populated by the focus-drift PR. Used by
  // the dashboard's FocusCard to render drifting / dormant / lineage
  // states.
  last_seen_in_synth: string | null;
  missed_run_count: number;
  drift_flagged_at: string | null;
  promoted_from_candidate_id: number | null;
  evolved_from_focus_id: number | null;
  evolved_from_name: string | null;
  signals_count: number;
  created_at: string | null;
  updated_at: string | null;
  // Tree-node compat fields baked in by `_focus_tree_node` so the same
  // object renders in the dashboard FocusCardsRow without a second fetch.
  children?: unknown[];
  progress?: { done: number; total: number };
  stale?: boolean;
}

export interface ApiFocusEvidence {
  kind: string;
  id: number;
  snippet: string;
}

export interface ApiFocusDetail extends ApiFocus {
  evidence: ApiFocusEvidence[];
}

export async function fetchFocuses(): Promise<ApiFocus[]> {
  const res = await apiFetch(`${BASE}/focuses`);
  if (!res.ok) throw new Error("Failed to fetch focuses");
  return res.json();
}

export async function fetchTodos(): Promise<ApiTodoBundle> {
  const res = await apiFetch(`${BASE}/todos`);
  if (!res.ok) throw new Error("Failed to fetch todos");
  return res.json();
}

export async function createTodo(body: {
  text: string;
  subtitle?: string | null;
  focus_id?: number | null;
  due_date?: string | null;
  state?: TodoState;
}): Promise<ApiTodo> {
  const res = await apiFetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to create todo");
  return res.json();
}

export async function updateTodo(
  id: number,
  patch: Partial<{
    text: string;
    subtitle: string | null;
    state: TodoState;
    focus_id: number | null;
    is_primary: boolean;
    due_date: string | null;
    sort_order: number;
    done: boolean;
    closure_note: string | null;
  }>,
): Promise<ApiTodo> {
  const res = await apiFetch(`${BASE}/todos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update todo");
  return res.json();
}

export async function cycleTodoState(id: number): Promise<ApiTodo> {
  const res = await apiFetch(`${BASE}/todos/${id}/cycle`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to cycle todo");
  return res.json();
}

export async function deleteTodo(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/todos/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete todo");
}

export async function promoteTodoToPrimary(id: number): Promise<ApiTodo> {
  const res = await apiFetch(`${BASE}/todos/${id}/promote-to-primary`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to promote todo to primary");
  return res.json();
}

// ── G3.5 Todo Continuity — close-with-outcome + chain + search ──────

export interface SpawnedTodoSpec {
  text: string;
  due_hint?: string | null;
  subtitle?: string | null;
}

export interface CloseTodoResult {
  parent: ApiTodo;
  spawned: ApiTodo[];
  edges: number[];
}

export async function closeTodoWithOutcome(
  id: number,
  payload: { closure_note?: string | null; spawned?: SpawnedTodoSpec[] },
): Promise<CloseTodoResult> {
  const res = await apiFetch(`${BASE}/todos/${id}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to close todo with outcome");
  return res.json();
}

export interface TodoChainNode {
  todo: ApiTodo;
  depth: number;
}

export interface TodoChain {
  this: ApiTodo;
  ancestors: TodoChainNode[];
  descendants: TodoChainNode[];
}

export async function fetchTodoChain(
  id: number,
  maxDepth: number = 10,
): Promise<TodoChain> {
  const res = await apiFetch(`${BASE}/todos/${id}/chain?max_depth=${maxDepth}`);
  if (!res.ok) throw new Error("Failed to fetch todo chain");
  return res.json();
}

export async function linkTodoParent(
  childId: number,
  parentId: number,
): Promise<{ ok: boolean; child_id: number; parent_id: number }> {
  const res = await apiFetch(`${BASE}/todos/${childId}/link-parent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent_id: parentId }),
  });
  if (!res.ok) throw new Error("Failed to link parent");
  return res.json();
}

export async function unlinkTodoParent(
  childId: number,
  parentId: number,
): Promise<{ deleted: number }> {
  const res = await apiFetch(
    `${BASE}/todos/${childId}/parents/${parentId}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error("Failed to unlink parent");
  return res.json();
}

export async function searchTodos(
  q: string,
  limit: number = 10,
  includeDone: boolean = true,
): Promise<{ matches: ApiTodo[] }> {
  const params = new URLSearchParams({
    q,
    limit: String(limit),
    include_done: String(includeDone),
  });
  const res = await apiFetch(`${BASE}/todos/search?${params}`);
  if (!res.ok) throw new Error("Failed to search todos");
  return res.json();
}

export async function promoteBacklogTicket(
  ticketId: number,
): Promise<{ ticket: ApiBacklogTicket; todo: ApiTodo }> {
  const res = await apiFetch(`${BASE}/backlog/tickets/${ticketId}/promote`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to promote backlog ticket");
  return res.json();
}

export async function demoteBacklogTicket(
  ticketId: number,
): Promise<ApiBacklogTicket> {
  const res = await apiFetch(`${BASE}/backlog/tickets/${ticketId}/demote`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to demote backlog ticket");
  return res.json();
}

// Focus ↔ Todo links — many-to-many. The same todo can appear under
// multiple focuses; the chip on a todo row shows where it's linked.
export interface FocusChip {
  id: number;
  text: string;
  is_primary: boolean;
}

export interface TodayTodo extends ApiItem {
  focuses: FocusChip[];
}

export async function fetchTodayTodos(): Promise<TodayTodo[]> {
  const res = await apiFetch(`${BASE}/items/today-todos`);
  if (!res.ok) throw new Error("Failed to fetch today's todos");
  return res.json();
}

export async function fetchFocusesForTodo(todoId: number): Promise<FocusChip[]> {
  const res = await apiFetch(`${BASE}/items/${todoId}/focuses`);
  if (!res.ok) throw new Error("Failed to fetch focuses for todo");
  return res.json();
}

export async function deriveTodoFromFocus(
  focusId: number,
  text: string,
  due_date?: string | null,
): Promise<{ todo: ApiItem; link_id: number }> {
  const res = await apiFetch(`${BASE}/items/${focusId}/derive-todo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, due_date: due_date ?? null }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "derive todo failed");
  }
  return res.json();
}

// ── Lists (unified) ─────────────────────────────────────────────────────────
//
// Backed by the List + ListItem tables. Replaces the old "Lists" feature
// (Notes-with-checklists in a Lists Space) and the "Gooni Backlog" Space.
// Type drives small UI variations only — the storage shape is uniform.

export type ListType = "todo" | "backlog" | "generic";

export type ListKind = "tasks" | "ideas";

export interface ApiList {
  id: number;
  name: string;
  type: ListType;
  kind: ListKind;
  emoji: string | null;
  sort_order: number;
  created_at: string | null;
}

// Board status mirrors the new todo state vocab so a backlog ticket
// promoted to a todo can share the same enum. Old values ('todo' /
// 'in_progress') were remapped by the dashboard-revamp migration to
// 'not_yet' / 'doing'.
export type BoardStatus = "not_yet" | "doing" | "done";

// Generic list row — focus / todo / backlog fields all moved to dedicated
// tables in the focus/todo/backlog extraction. ApiListItem now mirrors
// the slim list_items shape; backlog tickets use ApiBacklogTicket.
export interface ApiListItem {
  id: number;
  list_id: number;
  text: string;
  subtitle: string | null;
  done: boolean;
  actionable: boolean;
  completed_at: string | null;
  sort_order: number;
  source_note_id: number | null;
  created_at: string | null;
}

// Backlog ticket — engineering board state. Lives in `backlog_tickets`
// table (not list_items) since the focus/todo/backlog extraction.
export interface ApiBacklogTicket {
  id: number;
  text: string;
  subtitle: string | null;
  board_status: BoardStatus | null;
  pr_url: string | null;
  // Free-form ticket body — multi-line context, design notes, follow-up
  // scratch. Subtitle stays as the one-line tagline; notes is the story.
  notes: string | null;
  // Free-text agent attribution. Non-null while an autonomous worker
  // (e.g. "claude") is actively driving the ticket; auto-cleared by the
  // backend when the ticket flips to done.
  claimed_by: string | null;
  // Set when this backlog ticket was promoted into a todo via
  // POST /backlog/tickets/{id}/promote. Null means "engineering-only,
  // not on Daniel's todo list yet".
  todo_id: number | null;
  // Singleton — only one ticket across the table can have is_primary=true.
  // Set via promoteBacklogToPrimary / cleared via clearPrimaryBacklog or
  // by marking the ticket done. Drives the dashboard north-star banner.
  is_primary: boolean;
  done: boolean;
  completed_at: string | null;
  sort_order: number;
  source_note_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ApiListWithItems extends ApiList {
  items: ApiListItem[];
}

export async function fetchLists(): Promise<ApiList[]> {
  const res = await apiFetch(`${BASE}/lists`);
  if (!res.ok) throw new Error("Failed to fetch lists");
  return res.json();
}

export async function fetchList(id: number): Promise<ApiListWithItems> {
  const res = await apiFetch(`${BASE}/lists/${id}`);
  if (!res.ok) throw new Error("Failed to fetch list");
  return res.json();
}

export async function createList(
  name: string,
  type: ListType = "generic",
  emoji?: string | null,
): Promise<ApiList> {
  const res = await apiFetch(`${BASE}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, emoji }),
  });
  if (!res.ok) throw new Error("Failed to create list");
  return res.json();
}

export async function updateList(
  listId: number,
  patch: { name?: string; emoji?: string | null; kind?: ListKind },
): Promise<ApiList> {
  const res = await apiFetch(`${BASE}/lists/${listId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update list");
  return res.json();
}

export async function deleteList(listId: number): Promise<void> {
  const res = await apiFetch(`${BASE}/lists/${listId}`, { method: "DELETE" });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || "Failed to delete list");
  }
}

export async function addListItem(
  listId: number,
  text: string,
  opts: { subtitle?: string | null; source_note_id?: number | null; actionable?: boolean } = {},
): Promise<ApiListItem> {
  const res = await apiFetch(`${BASE}/lists/${listId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...opts }),
  });
  if (!res.ok) throw new Error("Failed to add list item");
  return res.json();
}

export async function updateListItem(
  itemId: number,
  patch: {
    text?: string;
    subtitle?: string | null;
    done?: boolean;
    actionable?: boolean;
    sort_order?: number;
  },
): Promise<ApiListItem> {
  const res = await apiFetch(`${BASE}/list-items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update list item");
  return res.json();
}

// ── Backlog tickets — extracted from list_items into their own table ──

export async function fetchBacklogTickets(includeDone = true): Promise<ApiBacklogTicket[]> {
  const res = await apiFetch(`${BASE}/backlog/tickets?include_done=${includeDone}`);
  if (!res.ok) throw new Error("Failed to fetch backlog tickets");
  return res.json();
}

export async function createBacklogTicket(
  text: string,
  opts: { subtitle?: string | null; source_note_id?: number | null; board_status?: BoardStatus | null } = {},
): Promise<ApiBacklogTicket> {
  const res = await apiFetch(`${BASE}/backlog/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...opts }),
  });
  if (!res.ok) throw new Error("Failed to create backlog ticket");
  return res.json();
}

export async function updateBacklogTicket(
  ticketId: number,
  patch: {
    text?: string;
    subtitle?: string | null;
    board_status?: BoardStatus | null;
    pr_url?: string | null;
    claimed_by?: string | null;
    done?: boolean;
    sort_order?: number;
  },
): Promise<ApiBacklogTicket> {
  const res = await apiFetch(`${BASE}/backlog/tickets/${ticketId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update backlog ticket");
  return res.json();
}

export async function deleteBacklogTicket(ticketId: number): Promise<void> {
  const res = await apiFetch(`${BASE}/backlog/tickets/${ticketId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete backlog ticket");
}

// ── Primary backlog ticket (singleton north-star banner) ──────────────────

export async function fetchPrimaryBacklog(): Promise<ApiBacklogTicket | null> {
  const res = await apiFetch(`${BASE}/backlog/tickets/primary`);
  if (!res.ok) throw new Error("Failed to fetch primary backlog ticket");
  return res.json();
}

export async function promoteBacklogToPrimary(
  ticketId: number,
): Promise<ApiBacklogTicket> {
  const res = await apiFetch(`${BASE}/backlog/tickets/${ticketId}/promote-to-primary`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to promote backlog ticket to primary");
  return res.json();
}

export async function clearPrimaryBacklog(): Promise<ApiBacklogTicket | null> {
  const res = await apiFetch(`${BASE}/backlog/tickets/primary/clear`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to clear primary backlog ticket");
  return res.json();
}

export async function deleteListItem(itemId: number): Promise<void> {
  const res = await apiFetch(`${BASE}/list-items/${itemId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete list item");
}

export async function reorderListItems(ids: number[]): Promise<void> {
  const res = await apiFetch(`${BASE}/list-items/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error("Failed to reorder list items");
}

export interface ChatGraphNode {
  id: number;
  label: string;
  role: "user" | "assistant";
}

export interface ChatGraphEdge {
  from: number;
  to: number;
}

export async function fetchConversationGraph(
  id: number,
): Promise<{ nodes: ChatGraphNode[]; edges: ChatGraphEdge[] }> {
  const res = await apiFetch(`${BASE}/conversations/${id}/graph`);
  if (!res.ok) throw new Error("Failed to fetch conversation graph");
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

export interface DashboardStats {
  notes_this_week: number;
  notes_last_week: number;
  recent_notes: ApiNote[];
  streak: number;
  notes_per_day: number[];
  activity_per_day: number[];
  mcp_calls_today: number;
  mcp_last_active_at: string | null;
  // focus-cam (https://github.com/gub1th/focus-cam) writes finalized
  // sessions to the same SQLite DB. Fields stay 0 / null / [] when no
  // sessions exist (fresh DB or focus-cam never run).
  focus_cam_sessions_total: number;
  focus_cam_7d: Array<{
    date: string;          // YYYY-MM-DD
    sessions: number;
    score: number | null;  // null if all sessions in that day had no score
    duration_sec: number;
  }>;
  focus_cam_7d_avg_score: number | null;
}

// Stats are cheap SQL — fetched fresh every time so recent-notes previews stay current.
export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await apiFetch(`${BASE}/dashboard`);
  if (!res.ok) throw new Error("Failed to fetch dashboard stats");
  return res.json() as Promise<DashboardStats>;
}

// ── Cut table (fitness/cut pipeline) ───────────────────────────────────
// Per-day calories/protein/weight/exercise rolled up from DailyMetric rows
// Daniel logs via chat. `today` carries the running daily totals the chat
// ack also surfaces.
export interface CutTableRow {
  date: string;             // YYYY-MM-DD
  calories: number;
  protein: number;
  weight: number | null;    // last weigh-in that day, null if none
  exercise: boolean;
  exercise_label: string | null;
  alcohol: number | null;   // per-day count, null if none
  weed: number | null;
  vape: number | null;
  note: string | null;      // freeform per-day annotation
}
export interface CutTable {
  rows: CutTableRow[];      // newest day first
  today: { calories: number; protein: number };
  updated_at?: string;
}
// `fill=true` returns an empty row for every day in the window (continuous
// grid for the editable dashboard view); false keeps only days with data.
export async function fetchCutTable(days = 30, fill = false): Promise<CutTable> {
  const res = await apiFetch(`${BASE}/metrics/cut-table?days=${days}&fill=${fill}`);
  if (!res.ok) throw new Error("Failed to fetch cut table");
  return res.json() as Promise<CutTable>;
}

// Numeric cut-table cells (cal/protein/weight/alcohol/weed/vape) send
// `value`; text cells (exercise label, note) send `text`. Passing both
// null clears the cell. Collapses the (date, metric_type) to one row
// server-side, so it's idempotent.
export type CutMetricType =
  | "calories" | "protein" | "weight"
  | "alcohol" | "weed" | "vape" | "exercise" | "note";
export async function setCutCell(
  date: string,
  metricType: CutMetricType,
  payload: { value?: number | null; text?: string | null },
): Promise<{ cleared: boolean; row: unknown }> {
  const res = await apiFetch(`${BASE}/metrics/cell`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, metric_type: metricType, ...payload }),
  });
  if (!res.ok) throw new Error("Failed to set cut cell");
  return res.json();
}

// Cut-table config: limits drive the cell red/green (cal green ≤ limit,
// protein green ≥ limit); start_date anchors the "Day N" counter.
export interface CutConfig {
  calorie_limit: number;
  protein_limit: number;
  start_date: string | null; // YYYY-MM-DD
}
export async function fetchCutConfig(): Promise<CutConfig> {
  const res = await apiFetch(`${BASE}/metrics/cut-config`);
  if (!res.ok) throw new Error("Failed to fetch cut config");
  return res.json() as Promise<CutConfig>;
}
export async function setCutConfig(patch: Partial<CutConfig>): Promise<CutConfig> {
  const res = await apiFetch(`${BASE}/metrics/cut-config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to set cut config");
  return res.json() as Promise<CutConfig>;
}


// Time spent on the gooni repo today + this week, estimated by clustering
// commit timestamps from GitHub (server hits the GitHub API). All-zero
// payload when GitHub OAuth isn't connected.
export interface TimeOnGooni {
  configured: boolean;
  today_minutes: number;
  week_minutes: number;
  today_sessions: number;
  week_sessions: number;
  owner?: string;
  name?: string;
  error?: string;
}

export async function fetchTimeOnGooni(): Promise<TimeOnGooni> {
  const res = await apiFetch(`${BASE}/dashboard/time-on-gooni`);
  if (!res.ok) throw new Error("Failed to fetch time-on-gooni");
  return res.json() as Promise<TimeOnGooni>;
}

export interface ExtendedStats {
  notes_this_week: number;
  notes_total: number;
  conversations_total: number;
  user_messages_total: number;
  assistant_messages_total: number;
  user_messages_this_week: number;
  todos_done_this_week: number;
  todos_open: number;
}

export async function fetchExtendedStats(): Promise<ExtendedStats> {
  const res = await apiFetch(`${BASE}/dashboard/stats`);
  if (!res.ok) throw new Error("Failed to fetch extended stats");
  return res.json() as Promise<ExtendedStats>;
}

export interface OpenAIUsageModel {
  model: string;
  kind: "chat" | "embedding";
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface DayBucket {
  date: string;       // YYYY-MM-DD UTC
  input: number;
  output: number;
  cache_read?: number;
  cache_creation?: number;
}

export interface OpenAIUsage {
  configured: boolean;
  error?: string;
  month_start_unix?: number;
  spend_usd?: number;
  spend_today_usd?: number;
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  by_model?: OpenAIUsageModel[];
  by_day?: DayBucket[];
  fetched_at?: number;
}

export async function fetchOpenAIUsage(refresh = false): Promise<OpenAIUsage> {
  const url = refresh
    ? `${BASE}/dashboard/openai-usage?refresh=true`
    : `${BASE}/dashboard/openai-usage`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error("Failed to fetch OpenAI usage");
  return res.json() as Promise<OpenAIUsage>;
}

export interface ClaudeUsageModel {
  model: string;
  turns: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  est_cost_usd: number;
}

export interface ClaudeUsage {
  configured: boolean;
  // True when the section should render (local jsonls present OR DB has
  // ingested rows). False on a fresh prod box → frontend hides the section
  // entirely rather than showing an error stub.
  available?: boolean;
  window_days?: number;
  sessions?: number;
  turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  est_cost_usd?: number;
  by_day?: DayBucket[];
  by_model?: ClaudeUsageModel[];
  fetched_at?: number;
}

export async function fetchClaudeUsage(days = 30, refresh = false): Promise<ClaudeUsage> {
  const params = new URLSearchParams({ days: String(days) });
  if (refresh) params.set("refresh", "true");
  const res = await apiFetch(`${BASE}/dashboard/claude-usage?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch Claude usage");
  return res.json() as Promise<ClaudeUsage>;
}

// Gooni's Takes — persisted server-side in `gooni_takes`, one row per UTC
// day per kind. Re-fetching a same-day take is a cheap DB read; force=true
// regenerates and overwrites the day's row.
export interface GooniTakePayload {
  id?: number;
  day: string;          // YYYY-MM-DD
  kind: "focus" | "dev";
  take: string;
  model?: string;
  prompt_version?: string;
  sources?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export async function fetchGooniTake(opts: { force?: boolean } = {}): Promise<GooniTakePayload> {
  const qs = opts.force ? "?force=1" : "";
  const res = await apiFetch(`${BASE}/dashboard/take${qs}`);
  if (!res.ok) throw new Error("Failed to fetch Gooni's Take");
  return res.json() as Promise<GooniTakePayload>;
}

export async function fetchDevTake(opts: { force?: boolean } = {}): Promise<GooniTakePayload> {
  const qs = opts.force ? "?force=1" : "";
  const res = await apiFetch(`${BASE}/dashboard/dev-take${qs}`);
  if (!res.ok) throw new Error("Failed to fetch dev take");
  return res.json() as Promise<GooniTakePayload>;
}

export async function fetchTakesHistory(
  kind: "focus" | "dev",
  limit = 30,
): Promise<GooniTakePayload[]> {
  const res = await apiFetch(`${BASE}/dashboard/takes/history?kind=${kind}&limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch takes history");
  return res.json() as Promise<GooniTakePayload[]>;
}

// Dev take v3 → JSON array of {theme, summary}. Older v2 rows store a
// plain paragraph. Parser returns either shape so callers can branch on
// the rendering path.
export interface DevThemeItem { theme: string; summary: string; }
export type DevTakeView =
  | { kind: "themes"; themes: DevThemeItem[] }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export function parseDevTake(raw: string | undefined | null): DevTakeView {
  if (!raw || !raw.trim()) return { kind: "empty" };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const themes: DevThemeItem[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const theme = String((item as { theme?: unknown }).theme ?? "").trim();
        const summary = String((item as { summary?: unknown }).summary ?? "").trim();
        if (theme && summary) themes.push({ theme, summary });
      }
      if (themes.length) return { kind: "themes", themes };
    }
  } catch {
    // fall through to plain-text render
  }
  return { kind: "text", text: raw };
}

// ── Conversations ──────────────────────────────────────────────────────────────

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
  status: "pending" | "promoted" | "dismissed";
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

export async function fetchConversations(): Promise<ApiConversation[]> {
  const res = await apiFetch(`${BASE}/feed`);
  if (!res.ok) throw new Error("Failed to fetch conversations");
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

// ── Settings (daily nudge) ────────────────────────────────────────────────────

export type NudgeChannel = "telegram" | "whatsapp";

export interface AppSettings {
  nudge_enabled: boolean;
  nudge_hour: number;        // 0-23
  nudge_minute: number;      // 0-59
  nudge_tz: string;          // IANA, e.g. "America/Los_Angeles"
  nudge_channels: NudgeChannel[];
  nudge_last_sent_day: string | null;
  nudge_prompt: string;      // user-editable instruction for the daily digest LLM
}

export async function fetchNudgePromptDefault(): Promise<string> {
  const res = await apiFetch(`${BASE}/settings/nudge-prompt-default`);
  if (!res.ok) throw new Error("Failed to fetch default prompt");
  const j = await res.json();
  return j.prompt || "";
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

export interface NudgeTestResult {
  sent: boolean;
  to?: string[];
  skipped?: string[];
  reason?: string;
}

export async function testNudge(): Promise<NudgeTestResult> {
  const res = await apiFetch(`${BASE}/settings/test-nudge`, { method: "POST" });
  if (!res.ok) throw new Error("test nudge failed");
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

export async function deleteEvalFeedback(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/eval/feedback/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete eval feedback");
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

// Persisted attachment row (note- or todo-owned). Shape matches the
// GET /{owner}/attachments list response.
export interface AttachmentMeta {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  url: string;
  created_at: string;
}

export async function fetchTodoAttachments(todoId: number): Promise<AttachmentMeta[]> {
  const res = await apiFetch(`${BASE}/todos/${todoId}/attachments`);
  if (!res.ok) throw new Error("Failed to load attachments");
  return res.json();
}

export async function deleteAttachment(attachmentId: number): Promise<void> {
  const res = await apiFetch(`${BASE}/attachments/${attachmentId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete attachment");
}

// ── Habits (daily binary trackers) ─────────────────────────────────────

export interface ApiHabitCell {
  date: string; // YYYY-MM-DD
  value: boolean | null; // null = unlogged / unknown
}

export interface ApiHabit {
  id: number;
  name: string;
  color: string | null;
  polarity: "positive" | "negative";
  archived_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  streak: number;
  recent: ApiHabitCell[]; // 7 cells, oldest → newest
}

export async function fetchHabits(): Promise<ApiHabit[]> {
  const res = await apiFetch(`${BASE}/habits`);
  if (!res.ok) throw new Error("Failed to fetch habits");
  return res.json();
}

export async function createHabit(
  name: string,
  polarity: "positive" | "negative" = "positive",
  color?: string,
): Promise<ApiHabit> {
  const res = await apiFetch(`${BASE}/habits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, polarity, color }),
  });
  if (!res.ok) throw new Error("Failed to create habit");
  return res.json();
}

export async function patchHabit(
  id: number,
  patch: Partial<{
    name: string;
    color: string;
    polarity: "positive" | "negative";
    sort_order: number;
    archived: boolean;
  }>,
): Promise<ApiHabit> {
  const res = await apiFetch(`${BASE}/habits/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to patch habit");
  return res.json();
}

export async function deleteHabit(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/habits/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete habit");
}

export async function setHabitEntry(
  habitId: number,
  day: string,
  value: boolean,
): Promise<void> {
  const res = await apiFetch(`${BASE}/habits/${habitId}/entries/${day}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error("Failed to set entry");
}

export async function unlogHabitEntry(habitId: number, day: string): Promise<void> {
  const res = await apiFetch(`${BASE}/habits/${habitId}/entries/${day}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to unlog entry");
}

// ── Focus candidates + drift mutators ──────────────────────────────────

export interface ApiFocusCandidate {
  id: number;
  name: string;
  endgoal: string | null;
  category: string;
  confidence: number;
  reasoning: string | null;
  cluster_signature: string;
  evidence: ApiFocusEvidence[];
  parent_candidate_id: number | null;
  status: "proposed" | "promoted" | "dismissed";
  promoted_focus_id: number | null;
  promoted_at: string | null;
  dismissed_at: string | null;
  first_seen_in_synth: string | null;
  last_seen_in_synth: string | null;
  seen_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export async function fetchFocusCandidates(
  status: "proposed" | "promoted" | "dismissed" | "all" = "proposed",
): Promise<ApiFocusCandidate[]> {
  const res = await apiFetch(`${BASE}/focus-candidates?status=${status}`);
  if (!res.ok) throw new Error("Failed to fetch focus candidates");
  return res.json();
}

export async function runFocusCandidates(): Promise<{
  synth_stats: unknown;
  binding: unknown;
  persisted: ApiFocusCandidate[];
}> {
  const res = await apiFetch(`${BASE}/focus-candidates/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to run focus synth");
  return res.json();
}

export async function promoteFocusCandidate(
  id: number,
): Promise<{ candidate: ApiFocusCandidate; focus_id: number }> {
  const res = await apiFetch(`${BASE}/focus-candidates/${id}/promote`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to promote candidate");
  return res.json();
}

export async function dismissFocusCandidate(
  id: number,
): Promise<ApiFocusCandidate> {
  const res = await apiFetch(`${BASE}/focus-candidates/${id}/dismiss`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to dismiss candidate");
  return res.json();
}

export async function fetchFocusDetail(id: number): Promise<ApiFocusDetail> {
  const res = await apiFetch(`${BASE}/focuses/${id}`);
  if (!res.ok) throw new Error("Failed to fetch focus detail");
  return res.json();
}

export async function renameFocus(
  id: number, body: { text?: string; endgoal?: string },
): Promise<ApiFocus> {
  const res = await apiFetch(`${BASE}/focuses/${id}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to rename focus");
  return res.json();
}

export async function forkFocus(
  id: number, body: { new_text: string; new_endgoal?: string },
): Promise<{ old_focus: ApiFocus; new_focus: ApiFocus }> {
  const res = await apiFetch(`${BASE}/focuses/${id}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to fork focus");
  return res.json();
}

// ── Ops mode (backlog + evals + tool failures) ─────────────────────────

export interface ToolCallFailure {
  id: number;
  tool_name: string;
  error: string;
  conversation_id: number | null;
  message_id: number | null;
  started_at: string | null;
}

export async function fetchToolCallFailures(
  days = 7, limit = 20,
): Promise<ToolCallFailure[]> {
  const res = await apiFetch(`${BASE}/tool-calls/failures?days=${days}&limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch tool failures");
  return res.json();
}

export interface ApiEvalSegment {
  id: number;
  conversation_id: number;
  source: string;
  last_message_at: string | null;
  message_count: number;
  eval_status: "not_yet" | "pending" | "done";
  overall_rating: number | null;
  overall_comment: string | null;
  preview?: string;
  title?: string | null;
  is_active?: boolean;
}

export async function fetchEvalSegments(
  opts: {
    statuses?: string;
    sources?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ApiEvalSegment[]> {
  const params = new URLSearchParams();
  if (opts.statuses) params.set("statuses", opts.statuses);
  if (opts.sources) params.set("sources", opts.sources);
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const res = await apiFetch(`${BASE}/eval/segments?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch eval segments");
  // Endpoint returns `{segments, total}` — unwrap to keep the
  // ApiEvalSegment[] contract callers expect. Without this OpsMode's
  // `n.map` blew up because `data` was the wrapper object.
  const body = await res.json();
  return Array.isArray(body) ? body : (body?.segments ?? []);
}

export async function patchEvalSegment(
  id: number,
  body: {
    eval_status?: string;
    overall_rating?: number;
    overall_comment?: string;
  },
): Promise<void> {
  const res = await apiFetch(`${BASE}/eval/segments/${id}/summary`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to patch eval segment");
}

// ── Gooni health (Build mode) ──────────────────────────────────────────

export type HealthAxisName =
  | "memory" | "chat" | "engagement"
  | "availability" | "cost" | "connectors";

export interface HealthComponent {
  name: string;
  score: number; // 0-100
  weight: number; // 0-1
  detail: string;
}

export interface HealthAxis {
  axis: HealthAxisName;
  score: number; // composite 0-100
  headline: string;
  components: HealthComponent[];
  error?: string;
}

export interface HealthScores {
  axes: HealthAxis[];
}

export async function fetchHealthScores(): Promise<HealthScores> {
  const res = await apiFetch(`${BASE}/health/scores`);
  if (!res.ok) throw new Error("Failed to fetch health scores");
  return res.json();
}

export async function deleteFocus(id: number): Promise<void> {
  // Focuses share the /items delete route w/ todos via item_service. The
  // service clears focus_id on linked todos before removing the row so
  // todos survive as focus-less.
  const res = await apiFetch(`${BASE}/items/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete focus");
}

export async function reactivateFocus(id: number): Promise<ApiFocus> {
  const res = await apiFetch(`${BASE}/focuses/${id}/reactivate`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to reactivate focus");
  return res.json();
}

export async function fetchTodosByFocus(focusId: number): Promise<ApiTodo[]> {
  const res = await apiFetch(`${BASE}/items/${focusId}/todos`);
  if (!res.ok) throw new Error("Failed to fetch focus todos");
  return res.json();
}

// ── Capability profile + Reflections ──────────────────────────────────────────

export type CapabilityLayer = "mechanical" | "functional" | "behavioral" | "architectural";
export type CapabilityStatus = "claimed" | "verified" | "unverified" | "broken" | "removed";

export interface ApiCapabilityFacet {
  id: number;
  layer: CapabilityLayer | string;
  facet_key: string;
  facet_text: string;
  polarity: "positive" | "negative";
  status: CapabilityStatus | string;
  source: string;
  evidence_json: string | null;
  last_verified_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CapabilitiesResponse {
  by_layer: Record<string, ApiCapabilityFacet[]>;
  total: number;
}

export async function fetchCapabilityFacets(): Promise<CapabilitiesResponse> {
  const res = await apiFetch(`${BASE}/capabilities`);
  if (!res.ok) throw new Error("Failed to fetch capabilities");
  return res.json();
}

export async function patchCapabilityFacet(
  id: number,
  patch: Partial<Pick<ApiCapabilityFacet, "facet_text" | "status" | "layer">>,
): Promise<ApiCapabilityFacet> {
  const res = await apiFetch(`${BASE}/capabilities/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to patch capability");
  return res.json();
}

export async function refreshCapabilityTelemetry(): Promise<Record<string, unknown>> {
  const res = await apiFetch(`${BASE}/capabilities/telemetry/refresh`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to refresh telemetry");
  return res.json();
}

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

export type ReactionTarget = "note" | "comment";

export interface ReactionBucket {
  emoji: string;
  count: number;
  reacted_by_me: boolean;
}

export async function fetchReactions(
  targetType: ReactionTarget,
  targetId: number,
  reactorId: string | null,
): Promise<ReactionBucket[]> {
  const params = new URLSearchParams({
    target_type: targetType,
    target_id: String(targetId),
  });
  if (reactorId) params.set("reactor_id", reactorId);
  const res = await apiFetch(`${BASE}/reactions?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch reactions");
  return res.json();
}

export async function toggleReaction(
  targetType: ReactionTarget,
  targetId: number,
  emoji: string,
  reactorId: string,
): Promise<ReactionBucket[]> {
  const res = await apiFetch(`${BASE}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_type: targetType,
      target_id: targetId,
      emoji,
      reactor_id: reactorId,
    }),
  });
  if (!res.ok) throw new Error("Failed to toggle reaction");
  return res.json();
}
