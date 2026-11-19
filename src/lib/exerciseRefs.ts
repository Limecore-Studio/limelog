// v1.22 (limelog#121, #122) — what history still points at, so a delete can
// keep it. Pure: the callers pass the programs and logs (programStore cannot
// import logStore, which imports it).
import type { Program } from '@/types/program';
import type { SessionLog } from '@/types/logging';

/** Whether a program slot, a logged set or a swap refers to the exercise. */
export function exerciseInUse(exerciseId: string, programs: Program[], logs: SessionLog[]): boolean {
  for (const p of programs) {
    for (const s of p.sessions) {
      if (s.exercises.some((e) => e.exerciseId === exerciseId)) return true;
    }
  }
  for (const l of logs) {
    if (l.sets.some((s) => s.exerciseId === exerciseId)) return true;
    if (l.exerciseSwaps && Object.values(l.exerciseSwaps).includes(exerciseId)) return true;
  }
  return false;
}

/** Whether any workout, finished or in progress, was logged for the session. */
export function sessionHasWorkouts(sessionId: string, logs: SessionLog[]): boolean {
  return logs.some((l) => l.sessionTemplateId === sessionId);
}
