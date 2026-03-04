import { FeedEntry as FeedEntryType } from "../services/api";

interface Props {
  entry: FeedEntryType;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function FeedEntry({ entry }: Props) {
  return (
    <div
      style={{
        display: "flex",
        gap: 20,
        padding: "6px 4px",
        borderRadius: 4,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "#f7fafc";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      <span
        style={{
          color: "#a0aec0",
          fontSize: 13,
          whiteSpace: "nowrap",
          flexShrink: 0,
          paddingTop: 1,
        }}
      >
        {formatTime(entry.created_at)}
      </span>
      <span style={{ fontSize: 14, color: "#1a202c", lineHeight: 1.5 }}>
        {entry.content}
      </span>
    </div>
  );
}
