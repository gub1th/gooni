import { create } from "zustand";
import {
  fetchLists,
  fetchList,
  createList as apiCreateList,
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
  addItem: (
    listId: number,
    text: string,
    opts?: { subtitle?: string | null; source_note_id?: number | null },
  ) => Promise<ApiListItem>;
  updateItem: (
    itemId: number,
    patch: {
      text?: string;
      subtitle?: string | null;
      done?: boolean;
      sort_order?: number;
      due_date?: string | null;
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
      const arr = next[updated.list_id];
      if (arr) {
        next[updated.list_id] = arr.map((it) => (it.id === itemId ? updated : it));
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
