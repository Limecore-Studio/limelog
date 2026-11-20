// v1.22 (limelog#149, M part) — "Start an empty workout" from Today's empty
// state: log a lift without building a program first. Loaded on the tap.
//
// The workout page shows a session's exercises, so an empty workout is a
// session with none yet, in the user's own program ("My training", created
// active with a default phase when there is none), on today's weekday. The
// exercises added during it (the workout's "Add exercise") stay on that
// session, so next week's same day offers it again with them.
import type { TFunction } from 'i18next';
import { useProgramStore } from '@/store/programStore';
import { useLogStore } from '@/store/logStore';
import type { DayOfWeek } from '@/types/program';

/** Start it and return the new workout's id, to open. */
export function startEmptyWorkout(t: TFunction, today: Date = new Date()): string {
  const store = () => useProgramStore.getState();
  const name = t('today.emptyProgramName');
  let program = store().activeProgram ?? store().programs.find((p) => p.name === name) ?? null;
  if (!program) {
    program = store().createProgram({ name, status: 'archived' });
  }
  if (program.phases.length === 0) {
    store().addPhase(program.id, { name: t('program.defaultPhaseName'), type: 'accumulation', orderIndex: 0, weekStart: 1, weekEnd: 4 });
  }
  if (store().activeProgram?.id !== program.id) store().setActiveProgram(program.id);

  const current = store().programs.find((p) => p.id === program!.id)!;
  const phaseId = current.activePhaseId && current.phases.some((ph) => ph.id === current.activePhaseId)
    ? current.activePhaseId
    : [...current.phases].sort((a, b) => a.orderIndex - b.orderIndex)[0].id;
  store().addSession({
    phaseId,
    name: t('today.emptyWorkoutName'),
    dayOfWeek: today.getDay() as DayOfWeek,
    orderIndex: current.sessions.filter((s) => s.phaseId === phaseId).length,
  });
  const sessions = store().programs.find((p) => p.id === program!.id)!.sessions;
  const session = sessions[sessions.length - 1];
  return useLogStore.getState().startSession(session.id, program.id).id;
}
