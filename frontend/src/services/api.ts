const BASE = "http://localhost:8000";

// ── Feed item types ────────────────────────────────────────────────────────────

export interface ApiConversation {
  id: number;
  type: "conversation";
  title: string | null;
  summary: string | null;
  goal_id: number | null;
  space_id: number | null;
  source: string;
  created_at: string;
}

export type ApiFeedItem = ApiConversation;

export interface ApiSpace {
  id: number;
  name: string;
  goal_id: number | null;
}

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
  entryContent: string
): Promise<ApiMessage[]> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entry_content: entryContent }),
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
  entryContent = ""
): Promise<ApiMessage[]> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, entry_content: entryContent }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

// ── Goals ──────────────────────────────────────────────────────────────────────

export interface Goal {
  id: number;
  title: string;
  goal_type: "achieve" | "avoid";
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

// ── Spaces ─────────────────────────────────────────────────────────────────────

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

export async function fetchSpaceFeed(spaceId: number): Promise<ApiFeedItem[]> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/feed`);
  if (!res.ok) throw new Error("Failed to fetch space feed");
  return res.json();
}

export async function createSpaceConversation(spaceId: number | "general", content: string): Promise<ApiConversation> {
  const res = await fetch(`${BASE}/spaces/${spaceId}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to create space conversation");
  return res.json();
}

