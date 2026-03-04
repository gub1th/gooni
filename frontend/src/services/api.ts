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

export async function sendChat(message: string): Promise<{ content: string }> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "user", content: message }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}
