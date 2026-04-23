import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

export type GooniFace = "smirk" | "side-eye" | "hyped" | "dead-inside" | "sus" | "crying-laughing";

export const GOONI_FACES: GooniFace[] = [
  "smirk",
  "side-eye",
  "hyped",
  "dead-inside",
  "sus",
  "crying-laughing",
];

export const GOONI_FACE_LABELS: Record<GooniFace, string> = {
  "smirk": "classic smirk",
  "side-eye": "side-eye",
  "hyped": "hyped",
  "dead-inside": "dead inside",
  "sus": "sus",
  "crying-laughing": "crying laughing",
};

interface FaceStore {
  face: GooniFace;
  setFace: (face: GooniFace) => void;
}

function loadInitialFace(): GooniFace {
  const stored = LocalStorageService.get<GooniFace>("gooni_face", "smirk");
  if (stored && GOONI_FACES.includes(stored)) return stored;
  return "smirk";
}

export const useGooniFaceStore = create<FaceStore>((set) => ({
  face: loadInitialFace(),
  setFace: (face) => {
    LocalStorageService.set("gooni_face", face);
    set({ face });
  },
}));
