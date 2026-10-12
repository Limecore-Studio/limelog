/**
 * Estimated one-rep-max (e1RM) utilities.
 *
 * Two formulas, blended by rep range:
 *
 *   Brzycki:  1RM = weight × 36 / (37 - reps)
 *     • Most accurate for low-rep sets (1-10).
 *     • Diverges sharply as reps approach 37 (denominator → 0).
 *     • Slight under-estimate at high reps.
 *
 *   Epley:    1RM = weight × (1 + reps / 30)
 *     • Most accurate for moderate-rep sets (5-15).
 *     • Linear, no asymptote — safe at high reps.
 *     • Slight over-estimate at very low reps (1-3).
 *
 * Convention here: use Brzycki for reps ≤ 10 (the strength range where
 * accuracy matters most), Epley for reps > 10 (where Brzycki gets unreliable).
 * Above ~12 reps, ALL formulas degrade — we cap the inputs and return null
 * for unreliable estimates rather than print a misleadingly precise number.
 *
 * All weights in kilograms. Caller is responsible for unit conversion at
 * the UI boundary (display layer formats lb/kg per user preference).
 */

export const MAX_RELIABLE_REPS = 12;

/** The blended Brzycki/Epley estimate with no reliability cap applied.
 *
 *  Only for re-valuing rows that already exist: a PR recorded before the two
 *  estimators were unified may sit above the cap, and re-valuing it with the
 *  shared formula keeps it comparable to new PRs without discarding history.
 *  Anything shown to the user as a fresh estimate should use estimate1RM,
 *  which refuses to guess above MAX_RELIABLE_REPS. */
export function estimate1RMRaw(weightKg: number, reps: number): number | null {
  if (!isFinite(weightKg) || !isFinite(reps)) return null;
  if (weightKg <= 0 || reps <= 0) return null;
  // 1 rep at the working weight IS the 1RM — no estimation needed.
  if (reps === 1) return weightKg;
  if (reps <= 10) {
    // Brzycki — pick the more accurate formula in the strength range.
    return weightKg * 36 / (37 - reps);
  }
  // Epley — used above 10 reps, where Brzycki starts to drift.
  return weightKg * (1 + reps / 30);
}

/** Compute estimated 1RM from a single set's weight + reps.
 *  Returns null for invalid inputs (zero/negative weight or reps, > MAX_RELIABLE_REPS)
 *  to keep the UI honest about formula reliability.
 *
 *  The single estimator for the whole app. PR detection used to carry its own
 *  uncapped Epley, which both admitted sets this one discards AND produced a
 *  different number for the same set — 100 kg × 5 scored 116.67 there against
 *  112.50 here, because that copy never got the Brzycki blend. */
export function estimate1RM(weightKg: number, reps: number): number | null {
  if (reps > MAX_RELIABLE_REPS) return null;
  return estimate1RMRaw(weightKg, reps);
}

/** A single 1RM data point with provenance. */
interface OneRMPoint {
  /** Estimated 1RM in kg. */
  estKg: number;
  /** ISO date of the session that produced this estimate. */
  date: string;
  /** Source set's weight, for tooltip/details display. */
  setWeightKg: number;
  /** Source set's reps, for tooltip/details display. */
  setReps: number;
}

/** Walk every completed set for an exercise and return the highest e1RM
 *  achieved on each session date. Returns oldest-first so a chart can
 *  plot the trend left-to-right without re-sorting.
 *
 *  "Best of session" rather than "every set" — the chart cares about
 *  per-day peaks. A user doing 5×5 produces one data point per session,
 *  not five.
 */
export function oneRMHistoryForExercise(
  sets: Array<{ exerciseId: string; weightKg: number | null; reps: number | null; completed: boolean }>,
  sessionLogs: Array<{ id: string; loggedAt: string; finalizedAt?: string; sets: Array<{ id: string; exerciseId: string; weightKg: number | null; reps: number | null; completed: boolean }> }>,
  exerciseId: string,
): OneRMPoint[] {
  // Group sets by session-log date. Only count finalized sessions —
  // in-progress logs would let a half-done PR show up, then disappear
  // when the user un-marks the set.
  const points: OneRMPoint[] = [];
  for (const log of sessionLogs) {
    if (!log.finalizedAt) continue;
    let bestEst = 0;
    let bestSet: { weightKg: number; reps: number } | null = null;
    for (const s of log.sets) {
      if (s.exerciseId !== exerciseId) continue;
      if (!s.completed) continue;
      if (s.weightKg == null || s.reps == null) continue;
      const est = estimate1RM(s.weightKg, s.reps);
      if (est == null) continue;
      if (est > bestEst) {
        bestEst = est;
        bestSet = { weightKg: s.weightKg, reps: s.reps };
      }
    }
    if (bestEst > 0 && bestSet) {
      points.push({
        estKg: bestEst,
        date: log.finalizedAt!,
        setWeightKg: bestSet.weightKg,
        setReps: bestSet.reps,
      });
    }
  }
  // Sort oldest-first for chart-friendly ordering.
  points.sort((a, b) => a.date.localeCompare(b.date));
  // Ignore the `sets` param explicitly; the per-set walk happens inside
  // each log above so the caller doesn't need to pre-flatten.
  void sets;
  return points;
}

/** Single best e1RM across all completed sessions, or null if none. */
export function bestEstimateForExercise(
  sessionLogs: Array<{ finalizedAt?: string; sets: Array<{ exerciseId: string; weightKg: number | null; reps: number | null; completed: boolean }> }>,
  exerciseId: string,
): number | null {
  let best = 0;
  for (const log of sessionLogs) {
    if (!log.finalizedAt) continue;
    for (const s of log.sets) {
      if (s.exerciseId !== exerciseId) continue;
      if (!s.completed) continue;
      if (s.weightKg == null || s.reps == null) continue;
      const est = estimate1RM(s.weightKg, s.reps);
      if (est != null && est > best) best = est;
    }
  }
  return best > 0 ? best : null;
}

/**
 * Deload heuristic — given the last N finalized session logs (most recent
 * first), compute the fraction of completed sets where the actual reps
 * fell short of the target's lower-bound. A ratio at or above the threshold
 * suggests the user is grinding and may benefit from a deload phase.
 *
 * Returns `{ ratio, missedSets, totalSets }`. Callers decide whether to
 * surface a suggestion (typical threshold: 0.30 across the last 3 sessions).
 *
 * Target reps come from the SessionExercise.targetReps string — accepts
 * "5", "5-8", "8x3", "AMRAP", etc. We parse a leading integer as the
 * lower-bound and skip sets whose target can't be parsed. They are looked up
 * per exercise, or per workout and exercise when given a function: since
 * v1.18.1 (LimeLog#73) Today passes each workout's own targets
 * (deloadTargetReps), because one exercise can be prescribed 8–12 in one phase
 * and 3–5 in the next.
 */
export function missedRepRatio<L extends { finalizedAt?: string; sets: Array<{ id: string; exerciseId: string; reps: number | null; completed: boolean }> }>(
  sessionLogs: L[],
  targetReps: Map<string, string> | ((log: L, exerciseId: string) => string | undefined),
  limit: number = 3,
): { ratio: number; missedSets: number; totalSets: number } {
  const finalized = sessionLogs.filter((l) => l.finalizedAt).slice(0, limit);
  let missed = 0;
  let total = 0;
  for (const log of finalized) {
    for (const s of log.sets) {
      if (!s.completed) continue;
      if (s.reps == null) continue;
      const target = typeof targetReps === 'function' ? targetReps(log, s.exerciseId) : targetReps.get(s.exerciseId);
      if (!target) continue;
      const m = target.match(/^(\d+)/);
      if (!m) continue; // unparseable (e.g. "AMRAP") — skip
      const targetLow = parseInt(m[1], 10);
      total++;
      if (s.reps < targetLow) missed++;
    }
  }
  return {
    ratio: total > 0 ? missed / total : 0,
    missedSets: missed,
    totalSets: total,
  };
}
