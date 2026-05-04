import { create } from "zustand";
import {
  fetchLists,
  fetchList,
  createList as apiCreateList,
  updateList as apiUpdateList,
  deleteList as apiDeleteList,
  addListItem as apiAddItem,
  updateListItem as apiUpdateItem,
  deleteListItem as apiDeleteItem,
  reorderListItems as apiReorder,
  type ApiList,
  type ApiListItem,
  type ListType,
} from "../services/api";

interface ListsStore {
  lists: ApiList[];
  activeListId: number | null;
  itemsByListId: Record<number, ApiListItem[]>;
  loading: boolean;

  fetchAll: () => Promise<void>;
  selectList: (id: number) => Promise<void>;
  createList: (name: string, type?: ListType, emoji?: string | null) => Promise<ApiList>;
  updateList: (id: number, patch: { name?: string; emoji?: string | null; kind?: "tasks" | "ideas" }) => Promise<void>;
  deleteList: (id: number) => Promise<void>;
  addItem: (
    listId: number,
    text: string,
    opts?: { subtitle?: string | null; source_note_id?: number | null; actionable?: boolean },
  ) => Promise<ApiListItem>;
  updateItem: (
    itemId: number,
    patch: {
      text?: string;
      subtitle?: string | null;
      done?: boolean;
      actionable?: boolean;
      is_primary?: boolean;
      sort_order?: number;
      due_date?: string | null;
      board_status?: import("../services/api").BoardStatus | null;
      pr_url?: string | null;
    },
  ) => Promise<void>;
  deleteItem: (itemId: number) => Promise<void>;
  reorder: (listId: number, ids: number[]) => Promise<void>;
}

export const useListsStore = create<ListsStore>((set, get) => ({
  lists: [],
  activeListId: null,
  itemsByListId: {},
  loading: false,

  fetchAll: async () => {
    set({ loading: true });
    try {
      const lists = await fetchLists();
      set({ lists });
    } catch (e) {
      console.error("fetchLists error:", e);
    } finally {
      set({ loading: false });
    }
  },

  selectList: async (id) => {
    set({ activeListId: id });
    try {
      const full = await fetchList(id);
      set((s) => ({
        itemsByListId: { ...s.itemsByListId, [id]: full.items },
      }));
    } catch (e) {
      console.error("fetchList error:", e);
    }
  },

  createList: async (name, type = "generic", emoji = null) => {
    const lst = await apiCreateList(name, type, emoji);
    set((s) => ({ lists: [...s.lists, lst] }));
    return lst;
  },

  updateList: async (id, patch) => {
    const updated = await apiUpdateList(id, patch);
    set((s) => ({
      lists: s.lists.map((l) => (l.id === id ? updated : l)),
    }));
  },

  deleteList: async (id) => {
    await apiDeleteList(id);
    set((s) => {
      const nextItems = { ...s.itemsByListId };
      delete nextItems[id];
      return {
        lists: s.lists.filter((l) => l.id !== id),
        itemsByListId: nextItems,
        activeListId: s.activeListId === id ? null : s.activeListId,
      };
    });
  },

  addItem: async (listId, text, opts) => {
    const item = await apiAddItem(listId, text, opts);
    set((s) => ({
      itemsByListId: {
        ...s.itemsByListId,
        [listId]: [...(s.itemsByListId[listId] || []), item],
      },
    }));
    return item;
  },

  updateItem: async (itemId, patch) => {
    const updated = await apiUpdateItem(itemId, patch);
    set((s) => {
      const next = { ...s.itemsByListId };
      // Mirror backend singleton: setting one item primary clears every other.
      const promotingPrimary = patch.is_primary === true;
      for (const lid of Object.keys(next).map(Number)) {
        next[lid] = next[lid].map((it) => {
          if (it.id === itemId) return updated;
          if (promotingPrimary && it.is_primary) return { ...it, is_primary: false };
          return it;
        });
      }
      return { itemsByListId: next };
    });
  },

  deleteItem: async (itemId) => {
    // optimistic — remove from whichever list contains it
    const { itemsByListId } = get();
    const next = { ...itemsByListId };
    for (const lid of Object.keys(next).map(Number)) {
      next[lid] = next[lid].filter((it) => it.id !== itemId);
    }
    set({ itemsByListId: next });
    try {
      await apiDeleteItem(itemId);
    } catch (e) {
      console.error("deleteItem error:", e);
      // rollback by refetching current list
      const active = get().activeListId;
      if (active != null) await get().selectList(active);
    }
  },

  reorder: async (listId, ids) => {
    set((s) => {
      const arr = s.itemsByListId[listId] || [];
      const byId = new Map(arr.map((it) => [it.id, it]));
      const next = ids.map((id, i) => ({ ...byId.get(id)!, sort_order: i }));
      return { itemsByListId: { ...s.itemsByListId, [listId]: next.filter(Boolean) } };
    });
    try {
      await apiReorder(ids);
    } catch (e) {
      console.error("reorderListItems error:", e);
      await get().selectList(listId);
    }
  },
}));
