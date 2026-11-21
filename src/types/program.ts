// A7 — movement pattern and equipment were closed sets of eight. Custom
// *exercises* were already supported, but each still had to be filed under a
// built-in pattern and a built-in equipment type, which does not survive
// contact with a sandbag carry or a Smith machine.
//
// The second branch widens the union without losing it: TypeScript still offers
// the eight literals as completions, while any other string type-checks.
// Spelled `string & Record<never, never>` rather than the more common
// `string & {}` because the latter trips @typescript-eslint/ban-types, and this
// repo lints at --max-warnings 0. The two are equivalent here.
//
// Nothing in the app switches exhaustively over either type — both are used for
// display, filtering, and injury-restriction matching, all of which work fine on
// an arbitrary string.
export type BuiltinMovementPattern =
  | 'push'
  | 'pull'
  | 'hinge'
  | 'squat'
  | 'carry'
  | 'jump'
  | 'accessory'
  | 'core';

export type MovementPattern = BuiltinMovementPattern | (string & Record<never, never>);

export type BuiltinEquipment =
  | 'barbell'
  | 'dumbbell'
  | 'machine'
  | 'cable'
  | 'bodyweight'
  | 'band'
  | 'kettlebell'
  | 'other';

export type Equipment = BuiltinEquipment | (string & Record<never, never>);

export interface Exercise {
  id: string;
  name: string;
  movementPattern: MovementPattern;
  primaryMuscle: string;
  equipment: Equipment;
  isBilateral: boolean;
  notes?: string;
  /** v1.22 (limelog#122) — removed from the library while programs or logged
   *  workouts still refer to it: no longer offered, still resolved by id so
   *  history, Progress and the cloud push keep its name. Adding the same
   *  name again brings it back with its id. */
  archived?: boolean;
}

export type PhaseType = 'accumulation' | 'intensification' | 'peaking' | 'deload';

export interface Phase {
  id: string;
  programId: string;
  name: string;
  type: PhaseType;
  orderIndex: number;
  weekStart: number;
  weekEnd: number;
  notes?: string;
}

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface SessionTemplate {
  id: string;
  phaseId: string;
  name: string;
  dayOfWeek: DayOfWeek;
  orderIndex: number;
  exercises: SessionExercise[];
  previousPerformance?: Record<string, number>;
  /** v1.22 (limelog#121) — deleted while it had workouts logged: kept, like
   *  deletePhase's kept sessions, so History can name them and an unfinished
   *  one can still be finished, but never offered or reminded about. */
  retired?: boolean;
  /** v1.22 (limelog#149) — made by "Start an empty workout". Removed again
   *  when that workout is discarded, or finished, with no exercises added. */
  fromEmptyStart?: boolean;
}

export interface SessionExercise {
  id: string;
  sessionId: string;
  exerciseId: string;
  orderIndex: number;
  targetSets: number;
  targetReps: string;
  targetRpe?: number;
  targetWeight?: number;
  restSeconds?: number;
  notes?: string;
}

export interface WorkoutTemplate {
  id: string;
  name: string;
  createdAt: string;
  exercises: Array<{
    exerciseId: string;
    orderIndex: number;
    targetSets: number;
    targetReps: string;
    targetRpe?: number;
    targetWeight?: number;
    notes?: string;
  }>;
}

export interface Program {
  id: string;
  userId: string;
  name: string;
  description?: string;
  status: 'active' | 'archived';
  createdAt: string;
  phases: Phase[];
  sessions: SessionTemplate[];
  exerciseBestRecords?: Record<string, { maxWeightKg: number; maxReps: number }>;
  /** v1.2 — current phase pointer. When undefined, the lowest-orderIndex
   *  phase is treated as active (back-compat with v1.1 programs). Advanced
   *  via programStore.advancePhase(). Manual phase-advance only — no
   *  auto-progression by elapsed weeks (deferred until program start-date
   *  tracking lands). */
  activePhaseId?: string;
  /** v1.22 (limelog#149) — created by "Start an empty workout"; removed
   *  again when its last session goes the same way. */
  fromEmptyStart?: boolean;
}
