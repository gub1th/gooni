import { create } from "zustand";
import {
  fetchConversations as apiFetchConversations,
  createConversation as apiCreateConversation,
  sendConversationMessage as apiSendMessage,
  sendConversationMessageStream as apiSendMessageStream,
  fetchConversationMessages as apiFetchMessages,
  type ApiConversation,
  type RouterSignals,
} from "../services/api";
import { useModelStore } from "./useModelStore";

// In-flight tool call card shape — populated by SSE tool_start/tool_done
// events while the assistant message is still being generated.
export interface InFlightTool {
  id: number | null;
  tool_name: string;
  status: "running" | "done" | "failed";
  error?: string | null;
}

interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  intention?: string;
  tools_used?: string[];
  signals?: RouterSignals;
}

interface ConversationsStore {
  conversations: ApiConversation[];
  activeId: number | null;
  messages: ConversationMessage[];
  sending: boolean;
  // Streaming UI state — live during a turn, cleared on done. UI reads
  // these to render the "Gooni is …" stage label + in-flight tool cards.
  streamingStage: string | null;
  streamingTools: InFlightTool[];

  fetchConversations: () => Promise<void>;
  selectConversation: (id: number) => Promise<void>;
  newChat: () => void;
  send: (content: string, noteContent?: string, imageUrl?: string) => Promise<void>;
}

export const useConversationsStore = create<ConversationsStore>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  sending: false,
  streamingStage: null,
  streamingTools: [],

  fetchConversations: async () => {
    try {
      const convos = await apiFetchConversations();
      set({ conversations: convos });
    } catch (e) {
      console.error(e);
    }
  },

  selectConversation: async (id) => {
    set({ activeId: id, messages: [] });
    try {
      const msgs = await apiFetchMessages(id);
      set({ messages: msgs });
    } catch (e) {
      console.error(e);
    }
  },

  newChat: () => {
    set({ activeId: null, messages: [] });
  },

  send: async (content, noteContent, imageUrl) => {
    // Component-level `if (sending) return` reads from a render-bound closure
    // and is stale between the click → setState → re-render flush. A rapid
    // Enter-Enter or stuck-key auto-repeat slips a second send() through. The
    // store sees the live value via get(), so guard once here as the canonical
    // single-fire boundary. See PR #NN for the WhatsApp counterpart.
    if (get().sending) return;
    const optimistic: ConversationMessage = {
      id: Date.now(),
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    set((s) => ({
      messages: [...s.messages, optimistic],
      sending: true,
      streamingStage: null,
      streamingTools: [],
    }));

    let convId = get().activeId;

    try {
      if (convId === null) {
        const conv = await apiCreateConversation(content || "(image)");
        convId = conv.id;
        set({ activeId: convId });
      }

      const model = useModelStore.getState().model;

      // Image path stays on the blocking endpoint — vision orchestrator
      // doesn't emit pipeline-step events (no intent/memory_recall stages
      // fire for image turns), so streaming buys nothing there.
      if (imageUrl) {
        const { messages: allMessages, intention: fallbackIntention, tools_used, signals } =
          await apiSendMessage(convId, content, noteContent, model, imageUrl);
        const intentionToUse = fallbackIntention || "";
        const hasSignals = !!signals && (
          signals.tone_corrections.length > 0
          || signals.feature_requests.length > 0
          || signals.memory_count > 0
        );
        const messagesWithMeta = allMessages.map((m, i) => {
          if (i !== allMessages.length - 1 || m.role !== "assistant") return m;
          return {
            ...m,
            ...(intentionToUse ? { intention: intentionToUse } : {}),
            ...(tools_used?.length ? { tools_used } : {}),
            ...(hasSignals && signals ? { signals } : {}),
          };
        });
        set({
          messages: messagesWithMeta,
          sending: false,
          streamingStage: null,
          streamingTools: [],
        });
        const convos = await apiFetchConversations();
        set({ conversations: convos });
        return;
      }

      // Streaming text path. Live updates flow through onEvent — stage
      // labels and tool cards render via streamingStage / streamingTools.
      // The terminal `done` event carries the full server-rendered
      // messages array, which replaces the optimistic state.
      await apiSendMessageStream(convId, content, noteContent, model, undefined, (evt) => {
        if (evt.type === "stage") {
          set({ streamingStage: evt.label });
        } else if (evt.type === "tool_start") {
          set((s) => ({
            streamingTools: [
              ...s.streamingTools,
              { id: evt.id, tool_name: evt.tool_name, status: "running" },
            ],
          }));
        } else if (evt.type === "tool_done") {
          set((s) => ({
            streamingTools: s.streamingTools.map((t) =>
              // Match on id when available (audit row id), else fall back
              // to the most recent running row with the same tool_name —
              // covers the edge case where db insert failed and id is null.
              (evt.id !== null && t.id === evt.id) ||
              (evt.id === null && t.id === null && t.tool_name === evt.tool_name && t.status === "running")
                ? { ...t, status: evt.status, error: evt.error }
                : t,
            ),
          }));
        } else if (evt.type === "done") {
          const intentionToUse = evt.intention || "";
          const hasSignals = !!evt.signals && (
            evt.signals.tone_corrections.length > 0
            || evt.signals.feature_requests.length > 0
            || evt.signals.memory_count > 0
          );
          const messagesWithMeta = evt.messages.map((m, i) => {
            if (i !== evt.messages.length - 1 || m.role !== "assistant") return m;
            return {
              ...m,
              ...(intentionToUse ? { intention: intentionToUse } : {}),
              ...(evt.tools_used?.length ? { tools_used: evt.tools_used } : {}),
              ...(hasSignals && evt.signals ? { signals: evt.signals } : {}),
            };
          });
          set({
            messages: messagesWithMeta,
            sending: false,
            streamingStage: null,
            streamingTools: [],
          });
        } else if (evt.type === "error") {
          console.error("Stream error:", evt.message);
          set({ sending: false, streamingStage: null, streamingTools: [] });
        }
      });

      const convos = await apiFetchConversations();
      set({ conversations: convos });
    } catch (e) {
      console.error(e);
      set({ sending: false, streamingStage: null, streamingTools: [] });
    }
  },
}));
