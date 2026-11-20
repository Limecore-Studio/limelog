// v1.22 (limelog#151) — planned sets shown before they are logged.
//
// A session exercise planned as 3×8–10 opened with no set rows, so every set
// cost an "Add set" tap first. The rows still to come are now drawn as ghost
// rows. A ghost is only a drawing: nothing is stored, counted or live-pushed
// for it until the user edits it or ticks it, and only then does it become a
// real set (logStore.logSet).

/** How many planned sets have no row yet. */
export function ghostCount(targetSets: number, logged: number): number {
  return Math.max(0, targetSets - logged);
}

/** The weight a ghost row offers (its placeholder, and what ✓ logs): the
 *  programmed weight, else what this set weighed last time. */
export function ghostWeightKg(
  setIndex: number,
  targetWeight: number | undefined,
  lastSets: readonly { weightKg: number | null }[] | undefined,
): number | undefined {
  if (targetWeight != null && targetWeight > 0) return targetWeight;
  const last = lastSets?.[setIndex]?.weightKg ?? lastSets?.[lastSets.length - 1]?.weightKg;
  return last != null && last > 0 ? last : undefined;
}
