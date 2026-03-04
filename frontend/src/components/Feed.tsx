import { useFeedStore } from "../stores/useFeedStore";
import { FeedEntry } from "./FeedEntry";
import { FeedEntry as FeedEntryType } from "../services/api";

function getDateLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function groupByDate(entries: FeedEntryType[]): [string, FeedEntryType[]][] {
  const groups: Map<string, FeedEntryType[]> = new Map();
  for (const e of entries) {
    const label = getDateLabel(e.created_at);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(e);
  }
  return Array.from(groups.entries());
}

export function Feed() {
  const entries = useFeedStore((s) => s.entries);

  if (entries.length === 0) {
    return (
      <div style={{ color: "#a0aec0", fontSize: 14, padding: "8px 4px" }}>
        Nothing yet. Start typing above.
      </div>
    );
  }

  const groups = groupByDate(entries);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {groups.map(([label, groupEntries]) => (
        <div key={label}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#a0aec0",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 6,
            }}
          >
            {label}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {groupEntries.map((e) => (
              <FeedEntry key={e.id} entry={e} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
