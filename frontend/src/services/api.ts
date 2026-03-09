const BASE = "http://localhost:8000";

// ── Spaces ─────────────────────────────────────────────────────────────────────

export interface ApiSpace {
  id: number;
  name: string;
  emoji: string | null;
  goal_id: number | null;
}

export async function fetchSpaces(): Promise<ApiSpace[]> {
  const res = await fetch(`${BASE}/spaces`);
  if (!res.ok) throw new Error("Failed to fetch spaces");
  return res.json();
}

export async function updateSpace(id: number, patch: { name?: string; emoji?: string | null }): Promise<ApiSpace> {
  const res = await fetch(`${BASE}/spaces/${id}`, {
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
  const res = await fetch(`${BASE}/spaces/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete space");
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
  last_opened_at: string | null;
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
    keepalive: true, // survives tab close
  });
  if (!res.ok) throw new Error("Failed to update note");
  return res.json();
}

export async function touchNote(id: number): Promise<void> {
  // Fire-and-forget — updates last_opened_at for relevancy sorting
  await fetch(`${BASE}/notes/${id}/touch`, { method: "POST" });
}

export async function memorizeNote(id: number): Promise<void> {
  // Fire-and-forget — called when leaving a note to extract a memory episode
  await fetch(`${BASE}/notes/${id}/memorize`, { method: "POST" });
}

export async function moveNote(id: number, toSpaceId: string): Promise<ApiNote> {
  const space_id = toSpaceId === "general" ? null : parseInt(toSpaceId);
  const res = await fetch(`${BASE}/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ space_id }),
  });
  if (!res.ok) throw new Error("Failed to move note");
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
