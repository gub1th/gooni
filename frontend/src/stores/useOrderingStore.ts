import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Per-device ordering for the sidebar's pinned-notes rows.
 * Stored in localStorage — the backend has no notion of user-chosen order.
 * Items not in the saved array fall back to their natural backend order
 * (new items appear at the end of whatever ordering already exists).
 */
interface OrderingStore {
  pinnedOrder: number[];
  setPinnedOrder: (ids: number[]) => void;
}

export const useOrderingStore = create<OrderingStore>()(
  persist(
    (set) => ({
      pinnedOrder: [],
      setPinnedOrder: (ids) => set({ pinnedOrder: ids }),
    }),
    { name: "gooni-ordering-v1" }
  )
);

/**
 * Sort `items` by their position in `order`. Items not in `order` are appended
 * at the end in their original order (so brand-new items don't disappear).
 */
export function applyOrder<T extends { id: number | string }>(
  items: T[],
  order: number[],
): T[] {
  if (!order.length) return items;
  const orderMap = new Map(order.map((id, i) => [id, i]));
  const ranked = items.map((item, idx) => {
    const id = typeof item.id === "string" ? NaN : item.id;
    const pos = orderMap.get(id);
    return { item, rank: pos ?? Number.MAX_SAFE_INTEGER, idx };
  });
  ranked.sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));
  return ranked.map((r) => r.item);
}
