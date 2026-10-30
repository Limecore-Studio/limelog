export interface SetLog {
  id: string;
  sessionLogId: string;
  exerciseId: string;
  setNumber: number;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  completed: boolean;
  notes?: string;
}

export type SessionMood = 'great' | 'good' | 'neutral' | 'bad' | 'terrible';

/**
 * v1.9 (Item 4) — cardio activities, logged without sets or a program.
 *
 * Open-ended by design: the picker offers this list, but the value is a plain
 * string end-to-end (and `activity_type` is `text`, not an enum, in Postgres),
 * so adding an activity never needs a migration and a value written by a newer
 * client never fails to store against an older schema.
 */
export const CARDIO_ACTIVITIES = ['run', 'cycle', 'swim', 'row', 'walk', 'other'] as const;

/**
 * v1.10 — team and skill training: basketball practice, a match, a dojo
 * session. Requested by an owner playing competitive basketball several times
 * a week, whose training load was invisible to the app and therefore to NCC's
 * Life Score.
 *
 * These ride the SAME storage as cardio — `activity_type` text, no sets, a
 * duration — because that shape is already exactly right for them, and because
 * `activity_type` has no CHECK constraint, so this list costs no migration.
 * What separates them is meaning, not structure: a practice is not cardio, and
 * filing it under "Cardio: other" would have quietly polluted every cardio
 * statistic. The split is therefore made where it actually matters — in the
 * picker and the labels — rather than by inventing a column.
 *
 * `otherSport` rather than reusing cardio's `other`: two entries with the same
 * stored value would be indistinguishable afterwards, and "Other" under
 * Training means a different thing from "Other" under Cardio.
 */
export const TRAINING_ACTIVITIES = [
  'basketball',
  'football',
  'floorball',
  'icehockey',
  'volleyball',
  'handball',
  'tennis',
  'martialArts',
  'otherSport',
] as const;

/** The two groups the picker offers. Presentation, not storage — nothing
 *  downstream of the modal needs to know which group a value came from. */
export const ACTIVITY_GROUPS = ['cardio', 'training'] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

export const ACTIVITIES_BY_GROUP: Record<ActivityGroup, readonly string[]> = {
  cardio: CARDIO_ACTIVITIES,
  training: TRAINING_ACTIVITIES,
};

export type BuiltinCardioActivity = (typeof CARDIO_ACTIVITIES)[number];
export type BuiltinTrainingActivity = (typeof TRAINING_ACTIVITIES)[number];
/** Named `CardioActivity` since v1.9 and kept for source compatibility, but it
 *  has always been the type of ANY non-strength activity — the value is open
 *  text end to end. v1.10 widened what it carries, not what it is. */
export type CardioActivity =
  | BuiltinCardioActivity
  | BuiltinTrainingActivity
  | (string & Record<never, never>);

/** Activities where a distance reading is meaningful. A basketball game has a
 *  duration but no sensible distance, so the field is hidden rather than shown
 *  as an empty box the user has to wonder about. Written in v1.9 with
 *  basketball as the hypothetical; v1.10 made it real, and no change was
 *  needed here — no training activity is on this list, so distance already
 *  hides itself for every one of them. */
export const DISTANCE_ACTIVITIES: readonly BuiltinCardioActivity[] = [
  'run',
  'cycle',
  'swim',
  'row',
  'walk',
];

export function activityTakesDistance(activity: CardioActivity | undefined): boolean {
  return !!activity && (DISTANCE_ACTIVITIES as readonly string[]).includes(activity);
}

export interface SessionLog {
  id: string;
  /**
   * v1.9 — optional. A cardio session is ad-hoc: it belongs to no program and
   * follows no session template. Requiring these was the entire reason non-gym
   * logging could not be built in v1.8 (LL-7 A8, deferred). Absent on cardio,
   * always present on a strength session logged from a program.
   */
  sessionTemplateId?: string;
  programId?: string;
  /**
   * v1.9 — set only on cardio sessions, and the discriminator for the whole
   * shape: absent means the pre-v1.9 strength session, driven by `sets`.
   */
  activityType?: CardioActivity;
  durationSeconds?: number;
  /** Metres. Absent for activities where distance means nothing. */
  distanceMeters?: number;
  loggedAt: string;
  finalizedAt?: string;
  /**
   * v1.20 (LimeLog#110 item 1) — 'cloud' on a workout this device got from a
   * pull rather than logged itself. Local only. Such a copy follows later pulls
   * (another device may still be adding sets to it); a workout made here, or
   * reopened here with Undo, has no origin and is never overwritten by one.
   */
  origin?: 'cloud';
  perceivedFatigue: number | null;
  notes?: string;
  sets: SetLog[];
  // v1.4 — optional post-workout AI debrief. The user types a free-text note
  // and the cloud Gemini proxy extracts structured fields. All null when the
  // user skips it or AI is unavailable (the FatigueRating dots remain the
  // always-available fallback). Stored locally + pushed to workout_sessions.
  aiDebriefRaw?: string | null;
  aiRpe?: number | null;
  aiPainFlags?: string[] | null;
  aiMood?: SessionMood | null;
  aiNoteSummary?: string | null;
  /**
   * v1.15 Item 8 — per-workout exercise swaps, SessionExercise id → the
   * exerciseId used instead. Local only (not in the Nexus push); the sets
   * already carry the substitute's exerciseId. See lib/exerciseSwap.ts.
   */
  exerciseSwaps?: Record<string, string>;
}

// v1.6 — Personal Records. Append-only: one row per PR achievement, so the
// per-exercise progression (sparkline) is just the rows for that exercise over
// time. "Current PR" for an exercise = the row with the highest oneRepMaxKg.
// Auto-detected on session finalize; never hand-entered. Pushed to the shared
// Supabase `exercise_prs` table (push-only, like workouts) for durability +
// cross-device, but the local copy is the on-device source of truth.
export interface ExercisePR {
  id: string;
  exerciseId: string;
  // Denormalised name at detection time — keeps the row meaningful even if the
  // exercise is later renamed/deleted, and lets the cloud row stand alone.
  exerciseName: string;
  weightKg: number;        // 0 for bodyweight
  reps: number;
  oneRepMaxKg: number;     // Epley estimate — ranks PRs across rep ranges
  sessionId: string;       // the SessionLog this PR was set in
  date: string;            // 'YYYY-MM-DD'
  createdAt: string;       // ISO
}

export type JumpCondition = 'fresh' | 'post_session' | 'morning';

export interface VerticalJumpLog {
  id: string;
  userId: string;
  loggedAt: string;
  heightCm: number;
  condition: JumpCondition;
  notes?: string;
}

export type StallFlagType = 'weight_plateau' | 'rpe_creep';

export interface StallFlag {
  id: string;
  exerciseId: string;
  detectedAt: string;
  sessionLogIds: string[];
  flagType: StallFlagType;
  resolved: boolean;
  resolutionAction?: 'deload' | 'exercise_swap' | 'technique_reset' | 'ignored';
}
