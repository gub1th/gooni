const BASE = "http://localhost:8000";

// ── Feed item types ────────────────────────────────────────────────────────────

export interface ApiNote {
  id: number;
  type: "note";
  content: string;
  title: string | null;
  goal_id: number | null;
  outcome: string | null;
  created_at: string;
}

export interface ApiConversation {
  id: number;
  type: "conversation";
  title: string | null;
  summary: string | null;
  goal_id: number | null;
  source: string;
  created_at: string;
}

export type ApiFeedItem = ApiNote | ApiConversation;

export interface ApiMessage {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

// ── Feed ───────────────────────────────────────────────────────────────────────

export async function fetchGoalFeed(goalId: number, limit = 100): Promise<ApiFeedItem[]> {
  const res = await fetch(`${BASE}/goals/${goalId}/feed?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch goal feed");
  return res.json();
}

export async function fetchGeneralFeed(limit = 100): Promise<ApiFeedItem[]> {
  const res = await fetch(`${BASE}/feed?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch general feed");
  return res.json();
}

// ── Notes ──────────────────────────────────────────────────────────────────────

export async function createGoalNote(goalId: number, content: string): Promise<ApiNote> {
  const res = await fetch(`${BASE}/goals/${goalId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to create goal note");
  return res.json();
}

export async function createGeneralNote(content: string): Promise<ApiNote> {
  const res = await fetch(`${BASE}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to create note");
  return res.json();
}

export async function updateNote(noteId: number, content: string): Promise<ApiNote> {
  const res = await fetch(`${BASE}/notes/${noteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to update note");
  return res.json();
}

// ── Conversations ──────────────────────────────────────────────────────────────

export async function createGoalConversation(goalId: number, content: string): Promise<ApiConversation> {
  const res = await fetch(`${BASE}/goals/${goalId}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to create goal conversation");
  return res.json();
}

export async function createGeneralConversation(content: string): Promise<ApiConversation> {
  const res = await fetch(`${BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function seedConversation(
  conversationId: number,
  goalId: number | null,
  entryContent: string
): Promise<ApiMessage[]> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal_id: goalId, entry_content: entryContent }),
  });
  if (!res.ok) throw new Error("Failed to seed conversation");
  return res.json();
}

export async function fetchConversationMessages(conversationId: number): Promise<ApiMessage[]> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`);
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

export async function sendConversationMessage(
  conversationId: number,
  content: string,
  goalId: number | null,
  entryContent = ""
): Promise<ApiMessage[]> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, goal_id: goalId, entry_content: entryContent }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

// ── Goals ──────────────────────────────────────────────────────────────────────

export interface Goal {
  id: number;
  title: string;
  goal_type: "achieve" | "avoid";
  streak: number;
  last_7_days: boolean[];
}

export async function fetchGoals(): Promise<Goal[]> {
  const res = await fetch(`${BASE}/goals`);
  if (!res.ok) throw new Error("Failed to fetch goals");
  return res.json();
}

export async function createGoal(title: string): Promise<Goal> {
  const res = await fetch(`${BASE}/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error("Failed to create goal");
  return res.json();
}

// ── Macros / Workout ───────────────────────────────────────────────────────────

export interface MacroItem {
  name: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface MealBreakdown {
  meal_type: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  items: MacroItem[];
  logged_at: string | null;
}

export interface DailyMacros {
  date: string;
  totals: { calories: number; protein: number; carbs: number; fat: number };
  meals: MealBreakdown[];
}

export interface WorkoutSetEntry {
  exercise: string;
  sets: number | null;
  reps: number | null;
  weight: number | null;
  weight_unit: string;
}

export interface WorkoutEntry {
  id: number;
  duration_minutes: number | null;
  logged_at: string | null;
  sets: WorkoutSetEntry[];
}

export interface DailyWorkout {
  date: string;
  workouts: WorkoutEntry[];
  total_exercises: number;
  total_sets: number;
  total_duration: number | null;
}

export async function fetchTodayWorkout(): Promise<DailyWorkout> {
  const res = await fetch(`${BASE}/workout/today`);
  if (!res.ok) throw new Error("Failed to fetch workout");
  return res.json();
}

export async function fetchTodayMacros(): Promise<DailyMacros> {
  const res = await fetch(`${BASE}/macros/today`);
  if (!res.ok) throw new Error("Failed to fetch macros");
  return res.json();
}

export async function sendChat(message: string, imageUrl?: string): Promise<{ content: string }> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: message, image_url: imageUrl }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}
