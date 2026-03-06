const BASE = "http://localhost:8000";

export interface Goal {
  id: number;
  title: string;
  goal_type: "achieve" | "avoid";
  streak: number;
  last_7_days: boolean[];
}

export interface FeedEntry {
  id: number;
  content: string;
  goal_id: number | null;
  outcome: string | null;
  created_at: string;
}

export async function fetchGoals(): Promise<Goal[]> {
  const res = await fetch(`${BASE}/goals`);
  if (!res.ok) throw new Error("Failed to fetch goals");
  return res.json();
}

export async function fetchFeed(): Promise<FeedEntry[]> {
  const res = await fetch(`${BASE}/feed`);
  if (!res.ok) throw new Error("Failed to fetch feed");
  return res.json();
}

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

export async function sendChat(message: string): Promise<{ content: string }> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: message }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}
