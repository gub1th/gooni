const BASE = "http://localhost:8000";

// ── Spaces ─────────────────────────────────────────────────────────────────────

export interface ApiSpace {
  id: number;
  name: string;
  goal_id: number | null;
}

export async function fetchSpaces(): Promise<ApiSpace[]> {
  const res = await fetch(`${BASE}/spaces`);
  if (!res.ok) throw new Error("Failed to fetch spaces");
  return res.json();
}

export async function createSpace(name: string): Promise<ApiSpace> {
  const res = await fetch(`${BASE}/spaces`, {
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
}

export async function fetchSpaceNotes(spaceId: number | "general"): Promise<ApiNote[]> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/notes`);
  if (!res.ok) throw new Error("Failed to fetch notes");
  return res.json();
}

export async function createNote(spaceId: number | "general"): Promise<ApiNote> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("Failed to create note");
  return res.json();
}

export async function updateNote(id: number, title: string, content: string): Promise<ApiNote> {
  const res = await fetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) throw new Error("Failed to update note");
  return res.json();
}

export async function deleteNote(id: number): Promise<void> {
  const res = await fetch(`${BASE}/notes/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete note");
}

// ── Jarvis ─────────────────────────────────────────────────────────────────────

export async function sendJarvisMessage(
  content: string,
  noteContent?: string
): Promise<{ content: string }> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content, entry_content: noteContent }),
  });
  if (!res.ok) throw new Error("Failed to send Jarvis message");
  return res.json();
}
