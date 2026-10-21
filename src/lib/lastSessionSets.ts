// ─── v1.6 Progressive overload — last-session lookup ─────────────────────
//
// When logging an exercise, surface what you did for it last time so you can
// decide whether to push. Pure helper over the in-memory session logs.

import type { SessionLog, SetLog } from '@/types/logging';
import { localDateKey } from '@/utils/localDate';

export interface LastSessionRef {
  date: string;          // 'YYYY-MM-DD' of that session
  sets: SetLog[];        // that exercise's sets, ordered by setNumber
}

/**
 * Find the sets for `exerciseId` from the most recent prior session (excluding
 * `excludeSessionId` and any session with no completed work for the exercise).
 * Returns null when there's no prior history. Pure — caller passes the logs.
 */
export function getLastSessionSets(
  sessionLogs: SessionLog[],
  exerciseId: string,
  excludeSessionId: string,
): LastSessionRef | null {
  // limelog#42: only work that was actually done counts. A set must be ticked
  // done AND carry reps > 0; anything else (an abandoned practice workout, a
  // set added and never finished, a set ticked with reps left empty by an
  // older build) is skipped. Only the counting sets are returned, so LAST never
  // shows "95 kg×—" next to a PR chip that says 95 kg×5.
  const counts = (s: SetLog) =>
    s.exerciseId === exerciseId && s.completed && s.reps != null && s.reps > 0;

  const candidates = sessionLogs
    .filter((l) => l.id !== excludeSessionId)
    .filter((l) => l.sets.some(counts))
    .sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime());

  for (const log of candidates) {
    const sets = log.sets
      .filter(counts)
      .sort((a, b) => a.setNumber - b.setNumber);
    if (sets.length > 0) {
      // Local day, not UTC's (v1.18.1, LimeLog#75).
      return { date: localDateKey(log.loggedAt), sets };
    }
  }
  return null;
}

/** Best estimated 1RM-equivalent top weight in a set list (for the "ahead of
 *  last session" nudge). Returns the max weightKg among completed sets, or 0. */
export function topWeight(sets: SetLog[]): number {
  let max = 0;
  for (const s of sets) {
    if (s.completed && s.weightKg != null && s.weightKg > max) max = s.weightKg;
  }
  return max;
}
