import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

export type GooniMascotType = "2d" | "3d";

export const GOONI_MASCOT_TYPES: GooniMascotType[] = ["2d", "3d"];

export const GOONI_MASCOT_LABELS: Record<GooniMascotType, string> = {
  "2d": "2D cartoon",
  "3d": "3D Mii-style",
};

interface MascotTypeStore {
  type: GooniMascotType;
  setType: (type: GooniMascotType) => void;
}

function loadInitial(): GooniMascotType {
  const stored = LocalStorageService.get<GooniMascotType>("gooni_mascot_type", "2d");
  if (stored === "2d" || stored === "3d") return stored;
  return "2d";
}

export const useGooniMascotTypeStore = create<MascotTypeStore>((set) => ({
  type: loadInitial(),
  setType: (type) => {
    LocalStorageService.set("gooni_mascot_type", type);
    set({ type });
  },
}));
