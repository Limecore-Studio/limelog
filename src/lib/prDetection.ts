// ─── v1.6 Personal Record detection ──────────────────────────────────────
//
// After a session is finalized we check each exercise for a new PR. A PR is
// ranked by estimated one-rep max (Epley), so a heavier set at fewer reps and
// a lighter set at more reps are comparable — the user beats their PR whenever
// their best estimated 1RM for an exercise exceeds the previous best.
//
// Pure functions — no storage, no React. The store orchestrates persistence +
// the celebration.

import type { SetLog, SessionLog, ExercisePR } from '@/types/logging';
import { estimate1RM } from '@/utils/oneRepMax';
import { localDateKey } from '@/utils/localDate';

/** The best scoring set for an exercise within a list of sets, by estimated
 *  1RM. Only completed sets with a positive weight + reps count. Returns null
 *  if none qualify.
 *
 *  Scoring goes through the shared estimate1RM, which returns null above
 *  MAX_RELIABLE_REPS. That deliberately means a very high-rep set can no longer
 *  set a PR: this module used to carry its own uncapped Epley, so a 20-rep set
 *  raised "New personal record" and then failed to appear on the Est. 1RM
 *  chart, which discards the same set as unreliable. A PR ranked on an estimate
 *  the app itself declines to plot is not one worth claiming. */
function bestSet(sets: SetLog[]): { weightKg: number; reps: number; oneRepMax: number } | null {
  let best: { weightKg: number; reps: number; oneRepMax: number } | null = null;
  for (const s of sets) {
    if (!s.completed) continue;
    if (s.weightKg == null || s.reps == null) continue;
    const orm = estimate1RM(s.weightKg, s.reps);
    if (orm == null || orm <= 0) continue;
    if (!best || orm > best.oneRepMax) {
      best = { weightKg: s.weightKg, reps: s.reps, oneRepMax: orm };
    }
  }
  return best;
}

/** The current PR (highest oneRepMaxKg) for an exercise from a PR list. */
export function currentPR(prs: ExercisePR[], exerciseId: string): ExercisePR | null {
  let best: ExercisePR | null = null;
  for (const p of prs) {
    if (p.exerciseId !== exerciseId) continue;
    if (!best || p.oneRepMaxKg > best.oneRepMaxKg) best = p;
  }
  return best;
}

/**
 * Inspect a finalized session and return a new PR row for every exercise whose
 * best estimated 1RM beats the existing PR for that exercise (or where no PR
 * exists yet). Caller supplies a name resolver + an id factory so this stays
 * free of app singletons.
 */
export function detectNewPRs(
  session: SessionLog,
  existingPRs: ExercisePR[],
  resolveName: (exerciseId: string) => string,
  makeId: () => string,
): ExercisePR[] {
  // The user's own calendar day, not UTC's (v1.18.1, LimeLog#75).
  const date = localDateKey(session.loggedAt);
  const createdAt = new Date().toISOString();

  // Group this session's sets by exercise.
  const byExercise = new Map<string, SetLog[]>();
  for (const s of session.sets) {
    const list = byExercise.get(s.exerciseId);
    if (list) list.push(s);
    else byExercise.set(s.exerciseId, [s]);
  }

  const newPRs: ExercisePR[] = [];
  for (const [exerciseId, sets] of byExercise) {
    const best = bestSet(sets);
    if (!best) continue;
    const prior = currentPR(existingPRs, exerciseId);
    // Strictly greater — re-hitting the same 1RM isn't a new PR. Compared at the
    // precision a PR is stored at (v1.18.1, LimeLog#72): the stored 109.09 from
    // 100 kg × 4 is below the same set's unrounded 109.0909, so doing 100 × 4
    // again used to claim a second PR.
    const oneRepMaxKg = Math.round(best.oneRepMax * 100) / 100;
    if (prior && oneRepMaxKg <= prior.oneRepMaxKg) continue;
    newPRs.push({
      id: makeId(),
      exerciseId,
      exerciseName: resolveName(exerciseId),
      weightKg: best.weightKg,
      reps: best.reps,
      oneRepMaxKg,
      sessionId: session.id,
      date,
      createdAt,
    });
  }
  return newPRs;
}
