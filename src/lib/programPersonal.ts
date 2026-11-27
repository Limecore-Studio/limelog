// v1.22 (limelog#127 item 7, limecore#99) — programs, templates and the
// exercise library are device configuration and stay on an account change
// (LimeLog#94). What in them is the person's own goes: free-text notes (on
// exercises, programmed exercises and templates) and each program's best
// records. Parking programs per account instead is deferred to the owner.
import type { Exercise, Program, WorkoutTemplate } from '@/types/program';

export function stripProgram(p: Program): Program {
  const { exerciseBestRecords: _records, ...rest } = p;
  void _records;
  return {
    ...rest,
    sessions: p.sessions.map((s) => ({ ...s, exercises: s.exercises.map(({ notes: _n, ...e }) => (void _n, e)) })),
  };
}

export function stripExercise({ notes: _n, ...e }: Exercise): Exercise {
  void _n;
  return e;
}

export function stripTemplate(t: WorkoutTemplate): WorkoutTemplate {
  return { ...t, exercises: t.exercises.map(({ notes: _n, ...e }) => (void _n, e)) };
}
