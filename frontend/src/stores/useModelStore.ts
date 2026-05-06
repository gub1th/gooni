import { create } from "zustand";
import { persist } from "zustand/middleware";

// Models are passed straight through to the OpenAI Chat Completions API
// on the backend (`app/llm/client.py` accepts any string). To add one,
// just append here — no backend change required.
//
// Backend default for bot channels (Telegram, WhatsApp, iMessage) is
// `gpt-5.4` (see `LLMClient.chat_model` in app/llm/client.py). Web chat
// uses whatever the user picks here, so the default below is gpt-5.4 too
// — keeps web vs bot parity.
export const MODELS = [
  { id: "gpt-5.4",      label: "GPT-5.4",      tagline: "flagship — daily driver" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", tagline: "fast & cheap, ~daily-driver quality" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 nano", tagline: "cheapest — near-instant replies" },
  { id: "o4-mini",      label: "o4 mini",      tagline: "reasoning — slower, deeper" },
  { id: "gpt-4o",       label: "GPT-4o",       tagline: "legacy fallback — long context, vision" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

interface ModelStore {
  model: ModelId;
  setModel: (m: ModelId) => void;
}

// Default = gpt-5.4 — same model bot channels use, so web/bot stay in
// parity. Persist key bumped (v2 → v3) because the v2 default was
// gpt-4o-mini (no longer in the picker); without bumping, anyone with
// stored state would land on a model id that's not in the new list.
export const useModelStore = create<ModelStore>()(
  persist(
    (set) => ({
      model: "gpt-5.4",
      setModel: (model) => set({ model }),
    }),
    { name: "gooni-model-v3" }
  )
);
