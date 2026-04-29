import { create } from "zustand";
import { persist } from "zustand/middleware";

// Models are passed straight through to the OpenAI Chat Completions API
// on the backend (`app/llm/client.py` accepts any string). To add one,
// just append here — no backend change required.
export const MODELS = [
  { id: "gpt-4o-mini",  label: "4o mini",   tagline: "fastest, cheapest — daily driver" },
  { id: "gpt-4o",       label: "4o",        tagline: "balanced — better reasoning" },
  { id: "gpt-4-turbo",  label: "4 Turbo",   tagline: "older but reliable on long context" },
  { id: "o1-mini",      label: "o1 mini",   tagline: "reasoning model — slower, deeper" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

interface ModelStore {
  model: ModelId;
  setModel: (m: ModelId) => void;
}

// Default = mini. Stronger models cost more per turn; opt in deliberately.
// Persist key bumped (v1 → v2) because the v1 default was gpt-4o; without
// bumping, anyone with stored state would still be on 4o until they pick.
export const useModelStore = create<ModelStore>()(
  persist(
    (set) => ({
      model: "gpt-4o-mini",
      setModel: (model) => set({ model }),
    }),
    { name: "gooni-model-v2" }
  )
);
