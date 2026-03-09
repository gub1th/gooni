const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, init);
}

// ── Spaces ─────────────────────────────────────────────────────────────────────

export interface ApiSpace {
  id: number;
  name: string;
  emoji: string | null;
  goal_id: number | null;
}

export async function fetchSpaces(): Promise<ApiSpace[]> {
  const res = await apiFetch(`${BASE}/spaces`);
  if (!res.ok) throw new Error("Failed to fetch spaces");
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

// Keep old name as alias for backwards compat within this session
export const renameSpace = (id: number, name: string) => updateSpace(id, { name });

export async function deleteSpace(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/spaces/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete space");
}

export async function createSpace(name: string): Promise<ApiSpace> {
  const res = await apiFetch(`${BASE}/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to create space");
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
}

export async function fetchSpaceNotes(spaceId: number | "general"): Promise<ApiNote[]> {
  const res = await apiFetch(`${BASE}/spaces/${spaceId}/notes`);
  if (!res.ok) throw new Error("Failed to fetch notes");
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

export async function deleteNote(id: number): Promise<void> {
  const res = await apiFetch(`${BASE}/notes/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete note");
}

// ── Dashboard ──────────────────────────────────────────────────────────────────

export interface DashboardStats {
  notes_this_week: number;
  workouts_this_week: number;
  active_goals_count: number;
  active_goals: { id: number; title: string; goal_type: string }[];
  recent_notes: ApiNote[];
  streak: number;
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const res = await apiFetch(`${BASE}/dashboard`);
  if (!res.ok) throw new Error("Failed to fetch dashboard stats");
  return res.json();
}

export async function fetchDashboardInsight(): Promise<{ insight: string | null }> {
  const res = await apiFetch(`${BASE}/dashboard/insight`);
  if (!res.ok) throw new Error("Failed to fetch dashboard insight");
  return res.json();
}

// ── Jarvis ─────────────────────────────────────────────────────────────────────

export async function sendJarvisMessage(
  content: string,
  noteContent?: string
): Promise<{ content: string }> {
  const res = await apiFetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent }),
  });
  if (!res.ok) throw new Error("Failed to send Jarvis message");
  return res.json();
}
