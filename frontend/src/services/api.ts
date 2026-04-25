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

// ── Todos ────────────────────────────────────────────────────────────────────

export interface ApiTodo {
  id: number;
  text: string;
  done: boolean;
  created_at: string;
  completed_at: string | null;
  sort_order: number;
}

export async function fetchTodos(): Promise<ApiTodo[]> {
  const res = await apiFetch(`${BASE}/todos`);
  if (!res.ok) throw new Error("Failed to fetch todos");
  return res.json();
}

export async function createTodo(text: string): Promise<ApiTodo> {
  const res = await apiFetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error("Failed to create todo");
  return res.json();
}

export async function updateTodo(
  id: number,
  patch: { text?: string; done?: boolean; sort_order?: number },
): Promise<ApiTodo> {
  const res = await apiFetch(`${BASE}/todos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update todo");
  return res.json();
}

export async function deleteTodo(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/todos/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete todo");
}

export async function reorderTodos(items: { id: number; sort_order: number }[]): Promise<void> {
  const res = await apiFetch(`${BASE}/todos/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error("Failed to reorder todos");
}

// Spawn a "Plan for <todo text>" note in General, linked to the todo via
// todo_notes. Returns the new note so the frontend can animate its title in.
export async function createTodoPlan(todoId: number): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/todos/${todoId}/plan`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to create plan from todo");
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

export async function sendConversationMessage(
  convId: number,
  content: string,
  noteContent?: string,
  model?: string
): Promise<{ messages: ApiMessage[]; intention: string; tools_used: string[] }> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent, model }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

export async function fetchConversationMessages(convId: number): Promise<ApiMessage[]> {
  const res = await apiFetch(`${BASE}/conversations/${convId}/messages`);
  if (!res.ok) throw new Error("Failed to fetch messages");
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

