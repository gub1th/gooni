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
  // Snapshot of what classify_note routed for this note's most recent save.
  // Mirrors the chat-side `signals` payload — drives the "Routed:" disclosure
  // under the title so Daniel sees memory writes + backlog items as soon as
  // the async classifier finishes. Null until classify has run.
  classify_signals?: NoteClassifySignals | null;
}

export async function fetchSpaceNotes(spaceId: number | "general"): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/spaces/${spaceId}/notes`);
  if (!res.ok) throw new Error("Failed to fetch notes");
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
  const res = await apiFetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
    keepalive: true, // survives tab close
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

export async function fetchRelatedNotes(id: number): Promise<ApiNote[]> {
  try {
    const res = await apiFetch(`${BASE}/notes/${id}/related?limit=3`);
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

export async function cleanupEmptyNotes(): Promise<{ deleted: number; ids: number[] }> {
  const res = await apiFetch(`${BASE}/notes/cleanup`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to clean up notes");
  return res.json();
}

export async function patchNote(
  id: number,
  patch: { is_public?: boolean; is_pinned?: boolean; title?: string; content?: string },
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

export interface ApiItem {
  id: number;
  list_id: number;
  parent_id: number | null;
  text: string;
  subtitle: string | null;
  endgoal: string | null;
  committed: boolean;
  done: boolean;
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
    done: boolean;
    due_date: string | null;
    subtitle: string | null;
    sort_order: number;
    parent_id: number | null;
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

// ── Lists (unified) ─────────────────────────────────────────────────────────
//
// Backed by the List + ListItem tables. Replaces the old "Lists" feature
// (Notes-with-checklists in a Lists Space) and the "Gooni Backlog" Space.
// Type drives small UI variations only — the storage shape is uniform.

export type ListType = "todo" | "backlog" | "generic";

export interface ApiList {
  id: number;
  name: string;
  type: ListType;
  emoji: string | null;
  sort_order: number;
  created_at: string | null;
}

export interface ApiListItem {
  id: number;
  list_id: number;
  text: string;
  subtitle: string | null;
  done: boolean;
  actionable: boolean;
  completed_at: string | null;
  sort_order: number;
  due_date: string | null;
  source_note_id: number | null;
  created_at: string | null;
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
  patch: { name?: string; emoji?: string | null },
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
    due_date?: string | null;
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

export async function suggestNoteQuestions(id: number): Promise<string[]> {
  const res = await apiFetch(`${BASE}/notes/${id}/suggest-questions`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to suggest questions");
  const json = await res.json();
  return json.questions ?? [];
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
}

// Stats are cheap SQL — fetched fresh every time so recent-notes previews stay current.
export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await apiFetch(`${BASE}/dashboard`);
  if (!res.ok) throw new Error("Failed to fetch dashboard stats");
  return res.json() as Promise<DashboardStats>;
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

export interface ApiMessage {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  is_feedback?: boolean;
  feedback_for_message_id?: number | null;
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
  tone_corrections: { rule: string }[];
  feature_requests: { title: string; why: string }[];
  memory_count: number;
}

export async function sendConversationMessage(
  convId: number,
  content: string,
  noteContent?: string,
  model?: string,
  mode?: "plan" | "chat"
): Promise<{ messages: ApiMessage[]; intention: string; tools_used: string[]; signals?: RouterSignals }> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent, model, mode }),
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

