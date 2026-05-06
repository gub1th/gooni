import { cachedFetch } from "./cache";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

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

function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
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

export async function updateSpace(id: number, patch: { name?: string; emoji?: string | null }): Promise<ApiSpace> {
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


// ── Notes ──────────────────────────────────────────────────────────────────────

export interface NoteClassifySignals {
  feature_requests: { title: string; list_item_id: number }[];
  memory_count: number;
  memory_types: string[];
  worth_expanding?: boolean;
  classified_at: string;
}

export interface ApiNote {
  id: number;
  title: string | null;
  content: string | null;
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

export async function fetchDraftNotes(): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/notes/drafts`);
  if (!res.ok) throw new Error("Failed to fetch draft notes");
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
}
export async function fetchDevActivity(): Promise<DevActivity> {
  const res = await apiFetch(`${BASE}/dashboard/dev-activity`);
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
  patch: { is_public?: boolean; is_pinned?: boolean; is_draft?: boolean; title?: string; content?: string },
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
}

export interface PublicNoteDetail {
  id: number;
  title: string | null;
  content: string | null;
  space_name: string | null;
  created_at: string;
  updated_at: string;
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

export async function fetchPublicProfile(): Promise<{ bio: string | null; note_count: number; last_active: string | null }> {
  const res = await apiFetch(`${BASE}/public/profile`);
  if (!res.ok) throw new Error("Failed to fetch public profile");
  return res.json();
}

export async function fetchPublicVisitCount(): Promise<{ unique_visitors: number }> {
  const res = await apiFetch(`${BASE}/public/visits/count`);
  if (!res.ok) throw new Error("Failed to fetch visit count");
  return res.json();
}

// ── Items (unified focus + todo) ────────────────────────────────────────────
//
// One concept, one table. An item with `endgoal` and no parent renders as a
// focus; a leaf item renders as a todo; anything in between renders as a
// checklist node.

// Status: 'pending' was dropped in the focus-flow redesign — every focus is
// either committed or someday now.
export type FocusStatus = "committed" | "someday";
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
}

export interface ApiTodayItem extends ApiItem {
  parent_chain: string[];
}

export async function fetchItemTree(): Promise<ApiItemTree> {
  const res = await apiFetch(`${BASE}/items`);
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

export interface FocusSuggestion {
  text: string;
  endgoal: string | null;
  scale: FocusScale | null;
}

export async function suggestFocus(): Promise<FocusSuggestion> {
  const res = await apiFetch(`${BASE}/items/suggest-focus`);
  if (!res.ok) throw new Error("suggest failed");
  return res.json();
}

export async function reorderItems(ids: number[]): Promise<void> {
  const res = await apiFetch(`${BASE}/items/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error("Failed to reorder items");
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

export type BoardStatus = "todo" | "in_progress" | "done";

export interface ApiListItem {
  id: number;
  list_id: number;
  text: string;
  subtitle: string | null;
  done: boolean;
  actionable: boolean;
  is_primary: boolean;
  completed_at: string | null;
  sort_order: number;
  due_date: string | null;
  source_note_id: number | null;
  created_at: string | null;
  // Backlog Jira-board state. Null on legacy rows; renderers coalesce
  // to "todo" when null. Kept in sync with `done` server-side.
  board_status: BoardStatus | null;
  pr_url: string | null;
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
    is_primary?: boolean;
    sort_order?: number;
    due_date?: string | null;
    board_status?: BoardStatus | null;
    pr_url?: string | null;
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
}

// Stats are cheap SQL — fetched fresh every time so recent-notes previews stay current.
export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await apiFetch(`${BASE}/dashboard`);
  if (!res.ok) throw new Error("Failed to fetch dashboard stats");
  return res.json() as Promise<DashboardStats>;
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

// Gooni's Take — LLM call, cached separately so we don't pay tokens per tab switch.
// User can force-refresh via the refresh button next to the take.
const TAKE_CACHE_KEY = "gooni-take";
const TAKE_TTL_MS = 30 * 60 * 1000;

export async function fetchGooniTake(opts: { force?: boolean } = {}): Promise<{ take: string }> {
  return cachedFetch(
    TAKE_CACHE_KEY,
    TAKE_TTL_MS,
    async () => {
      const res = await apiFetch(`${BASE}/dashboard/take`);
      if (!res.ok) throw new Error("Failed to fetch Gooni's Take");
      return res.json() as Promise<{ take: string }>;
    },
    opts,
  );
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
    | "memories_applied";
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

export interface ApiMessage {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  is_feedback?: boolean;
  feedback_for_message_id?: number | null;
  trace?: MessageTraceStep[] | null;
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
  mode?: "plan" | "chat",
  imageUrl?: string,
): Promise<{ messages: ApiMessage[]; intention: string; tools_used: string[]; signals?: RouterSignals }> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent, model, mode, image_url: imageUrl }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

export async function fetchConversationMessages(convId: number): Promise<ApiMessage[]> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`);
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
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

// ── Gooni ─────────────────────────────────────────────────────────────────────

export async function fetchIntention(
  content: string,
  conversationId?: number
): Promise<{ intention: string }> {
  try {
    const res = await apiFetch(`${BASE}/chat/intention`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, conversation_id: conversationId }),
    });
    if (!res.ok) return { intention: "" };
    return res.json();
  } catch {
    return { intention: "" };
  }
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

export interface EvalMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string | null;
  is_feedback: boolean;
  feedback_for_message_id: number | null;
  trace: MessageTraceStep[] | null;
  step_feedback: EvalStepFeedback[];
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
