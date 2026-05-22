import { create } from "zustand";
import {
  type ApiBacklogTicket,
  type BoardStatus,
  fetchBacklogTickets,
  createBacklogTicket,
  updateBacklogTicket,
  deleteBacklogTicket,
} from "../services/api";

interface BacklogStoreState {
  tickets: ApiBacklogTicket[];
  loading: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
  createTicket: (text: string, opts?: { board_status?: BoardStatus | null; subtitle?: string | null }) => Promise<ApiBacklogTicket>;
  updateTicket: (id: number, patch: {
    text?: string;
    subtitle?: string | null;
    board_status?: BoardStatus | null;
    pr_url?: string | null;
    claimed_by?: string | null;
    done?: boolean;
    sort_order?: number;
  }) => Promise<void>;
  deleteTicket: (id: number) => Promise<void>;
  reorder: (orderedIds: number[]) => Promise<void>;
}

// Backlog tickets live in a dedicated table now (was list_items rows in
// a list of type='backlog'). One in-memory store for the whole board.
export const useBacklogStore = create<BacklogStoreState>((set, get) => ({
  tickets: [],
  loading: false,
  loaded: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const rows = await fetchBacklogTickets(true);
      set({ tickets: rows, loaded: true });
    } finally {
      set({ loading: false });
    }
  },

  createTicket: async (text, opts = {}) => {
    const created = await createBacklogTicket(text, opts);
    // Prepend so the new ticket appears at the top of its column —
    // matches Jira/Linear "just-added shows at top" expectation.
    // Sort_order from the server still wins on next refresh.
    set({ tickets: [created, ...get().tickets] });
    return created;
  },

  updateTicket: async (id, patch) => {
    const updated = await updateBacklogTicket(id, patch);
    set({ tickets: get().tickets.map((t) => (t.id === id ? updated : t)) });
  },

  deleteTicket: async (id) => {
    await deleteBacklogTicket(id);
    set({ tickets: get().tickets.filter((t) => t.id !== id) });
  },

  // Persist new sort_order for the supplied id sequence, then optimistically
  // re-sort the local cache so the UI reflects the move without a refetch.
  reorder: async (orderedIds) => {
    await Promise.all(
      orderedIds.map((id, idx) => updateBacklogTicket(id, { sort_order: idx })),
    );
    const idToOrder = new Map(orderedIds.map((id, idx) => [id, idx]));
    set({
      tickets: get().tickets.map((t) =>
        idToOrder.has(t.id) ? { ...t, sort_order: idToOrder.get(t.id)! } : t,
      ),
    });
  },
}));
