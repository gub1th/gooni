import { create } from "zustand";
import { persist } from "zustand/middleware";

export const MODELS = [
  { id: "gpt-4o-mini", label: "mini" },
  { id: "gpt-4o", label: "4o" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

interface ModelStore {
  model: ModelId;
  setModel: (m: ModelId) => void;
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set) => ({
      model: "gpt-4o",
      setModel: (model) => set({ model }),
    }),
    { name: "gooni-model-v1" }
  )
);
