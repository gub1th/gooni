import { fetchPublicNote, fetchPublicNotes, fetchPublicProfile, fetchPublicVisitCount } from "../services/api";

// Centralized query options so the list, detail, and any prefetcher all use
// the same key. Without this, hover-prefetch would write to one cache slot
// and the detail-page useQuery would read another.
export const publicNoteQueryOptions = (id: number) => ({
  queryKey: ["public-note", id] as const,
  queryFn: () => fetchPublicNote(id),
  staleTime: 60_000,
});

export const publicNotesListQueryOptions = () => ({
  queryKey: ["public-notes"] as const,
  queryFn: fetchPublicNotes,
});

export const publicProfileQueryOptions = () => ({
  queryKey: ["public-profile"] as const,
  queryFn: fetchPublicProfile,
});

export const publicVisitCountQueryOptions = () => ({
  queryKey: ["public-visits"] as const,
  queryFn: fetchPublicVisitCount,
});
