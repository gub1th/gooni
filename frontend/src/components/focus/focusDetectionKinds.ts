// Shared vocabulary for camera-cam detection kinds — was three separate
// copies of the same label map (`FocusCameraStatus`, `FocusEvidenceGallery`,
// `FocusSessionRecap`) plus two independent "which kinds count as what"
// splits. One owner so the recap's timeline/score and the live indicator's
// violation count can't drift into disagreeing about the same kind.

export const KIND_LABEL: Record<string, string> = {
  phone: "phone",
  vape: "vape",
  distracted: "distracted",
  stand: "stood up",
  left_desk: "left desk",
};

export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  return KIND_LABEL[kind] ?? kind;
}

/** Present at the desk but off-task — mirrors
 *  `focus_cam_service.VIOLATION_EVENT_KINDS` / `FocusCameraStatus`'s split. */
export const DISTRACTION_KINDS = new Set(["distracted", "phone", "vape"]);

/** Not at the desk at all — `stand`/`left_desk` are presence events, not
 *  on-task lapses, same split the live indicator already makes. */
export const AWAY_KINDS = new Set(["stand", "left_desk"]);
