export interface Note {
  id: number;
  title: string | null;
  content: string | null;
  space_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationFeedItem {
  id: number;
  type: "conversation";
  title: string | null;
  summary: string | null;
  goal_id: number | null;
  space_id: number | null;
  source: string;
  created_at: string;
}

export type FeedItem = ConversationFeedItem;

export interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface NotesState {
  spaces: never[];
  selectedSpaceId: string | null;
  selectSpace: (id: string) => void;

  // Feed entries keyed by spaceId
  feedEntries: Record<string, FeedItem[]>;
  loadFeed: (spaceId: string) => Promise<void>;
  startConversation: (spaceId: string, content: string) => Promise<FeedItem | null>;
  seedConversation: (conversationId: number, entryContent: string) => Promise<void>;

  // Conversation messages keyed by conversationId
  messages: Record<number, Message[]>;
  loadMessages: (conversationId: number) => Promise<void>;
  sendMessage: (conversationId: number, content: string) => Promise<void>;

  // Which entry has conversation expanded
  expandedEntryId: number | null;
  setExpandedEntry: (id: number | null) => void;
}
