const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
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

export async function createNote(spaceId: number | "general"): Promise<ApiNote> {
  const res = await apiFetch(`${BASE}/spaces/${spaceId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
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

export async function fetchRelatedNotes(id: number): Promise<ApiNote[]> {
  try {
    const res = await apiFetch(`${BASE}/notes/${id}/related?limit=3`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function patchNote(id: number, patch: { is_public?: boolean }): Promise<ApiNote> {
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
}

export interface PublicNoteDetail {
  id: number;
  title: string | null;
  content: string | null;
  space_name: string | null;
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

export async function fetchPublicProfile(): Promise<{ bio: string | null }> {
  const res = await apiFetch(`${BASE}/public/profile`);
  if (!res.ok) throw new Error("Failed to fetch public profile");
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
  recent_notes: ApiNote[];
  streak: number;
  gooni_take: string;
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await apiFetch(`${BASE}/dashboard`);
  if (!res.ok) throw new Error("Failed to fetch dashboard stats");
  return res.json();
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

