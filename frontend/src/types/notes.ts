export interface Space {
  id: string;
  name: string;
  emoji?: string; // e.g. "🎧", "🎾"
  type: "system" | "folder" | "goal";
  section: "iCloud" | "Google" | "top";
  goalId?: number; // if set, this space is backed by a backend Goal
}

export interface Note {
  id: number;
  type: "note";
  content: string;
  title: string | null;
  goal_id: number | null;
  outcome: string | null;
  created_at: string;
}

export interface ConversationFeedItem {
  id: number;
  type: "conversation";
  title: string | null;
  summary: string | null;
  goal_id: number | null;
  source: string;
  created_at: string;
}

export type FeedItem = Note | ConversationFeedItem;

export interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface NotesState {
  spaces: Space[];
  selectedSpaceId: string | null;
  selectSpace: (id: string) => void;
  createSpace: (name: string, section?: Space["section"]) => void;

  // Feed entries keyed by spaceId
  feedEntries: Record<string, FeedItem[]>;
  loadFeed: (spaceId: string, goalId?: number) => Promise<void>;
  submitNote: (spaceId: string, goalId: number | null, content: string) => Promise<void>;
  startConversation: (spaceId: string, goalId: number | null, content: string) => Promise<FeedItem | null>;
  seedConversation: (conversationId: number, goalId: number | null) => Promise<void>;
  updateEntry: (noteId: number, content: string) => Promise<void>;

  // Conversation messages keyed by conversationId
  messages: Record<number, Message[]>;
  loadMessages: (conversationId: number) => Promise<void>;
  sendMessage: (conversationId: number, content: string, goalId: number | null) => Promise<void>;

  // Which entry has conversation expanded; which is loaded in editor for editing
  expandedEntryId: number | null;
  setExpandedEntry: (id: number | null) => void;
  activeEditEntryId: number | null;
  setActiveEditEntry: (id: number | null) => void;
}
