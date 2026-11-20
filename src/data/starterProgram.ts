// v1.22 (limelog#149, owner decision 2026-11-19) — a simple full-body program
// offered on first launch, so a new user can log a first set in a few taps
// instead of thirteen. Loaded only when the offer is taken.
//
// Three full-body days, two days apart, the first one TODAY so Today has a
// session to start straight away. Every exercise is a built-in library entry
// (by name): those are what the app shows in all ten languages, and a user who
// removed one gets it back from the built-in list.
import type { TFunction } from 'i18next';
import { useProgramStore, seedBuiltinExercises } from '@/store/programStore';
import { BUILTIN_EXERCISES } from '@/data/builtinExercises';
import type { DayOfWeek, Program } from '@/types/program';

interface Slot {
  name: string;
  sets: number;
  reps: string;
  rest: number;
}

const COMPOUND = 150;
const ACCESSORY = 90;

/** Exported for the test that every name is in the built-in library. */
export const STARTER_DAYS: { key: 'starterDayA' | 'starterDayB' | 'starterDayC'; offset: number; slots: Slot[] }[] = [
  {
    key: 'starterDayA',
    offset: 0,
    slots: [
      { name: 'Back Squat', sets: 3, reps: '5', rest: COMPOUND },
      { name: 'Barbell Bench Press', sets: 3, reps: '5', rest: COMPOUND },
      { name: 'Barbell Row', sets: 3, reps: '8-10', rest: ACCESSORY },
    ],
  },
  {
    key: 'starterDayB',
    offset: 2,
    slots: [
      { name: 'Romanian Deadlift', sets: 3, reps: '8', rest: COMPOUND },
      { name: 'Overhead Press', sets: 3, reps: '5', rest: COMPOUND },
      { name: 'Lat Pulldown', sets: 3, reps: '8-10', rest: ACCESSORY },
      { name: 'Goblet Squat', sets: 2, reps: '10-12', rest: ACCESSORY },
    ],
  },
  {
    key: 'starterDayC',
    offset: 4,
    slots: [
      { name: 'Conventional Deadlift', sets: 3, reps: '5', rest: COMPOUND },
      { name: 'Incline Dumbbell Press', sets: 3, reps: '8-10', rest: ACCESSORY },
      { name: 'Cable Row (Seated)', sets: 3, reps: '10', rest: ACCESSORY },
      { name: 'Lateral Raise', sets: 2, reps: '12-15', rest: ACCESSORY },
    ],
  },
];

/** Create the starter program, make it the active one, and return it. */
export async function createStarterProgram(t: TFunction, today: Date = new Date()): Promise<Program> {
  await seedBuiltinExercises();
  const store = () => useProgramStore.getState();

  const exerciseId = (name: string): string => {
    const found = store().exercises.find((e) => e.name === name && !e.archived);
    if (found) return found.id;
    const builtin = BUILTIN_EXERCISES.find((e) => e.name === name);
    if (!builtin) throw new Error(`starter program: "${name}" is not a built-in exercise`);
    return store().addExercise(builtin).id;
  };

  const program = store().createProgram({
    name: t('today.starterProgramName'),
    description: t('today.starterProgramDesc'),
    status: 'archived',
  });
  store().addPhase(program.id, { name: t('today.starterPhaseName'), type: 'accumulation', orderIndex: 0, weekStart: 1, weekEnd: 8 });
  const phaseId = store().programs.find((p) => p.id === program.id)!.phases[0].id;

  STARTER_DAYS.forEach((day, i) => {
    store().addSession({
      phaseId,
      name: t(`today.${day.key}`),
      dayOfWeek: ((today.getDay() + day.offset) % 7) as DayOfWeek,
      orderIndex: i,
    });
    const sessions = store().programs.find((p) => p.id === program.id)!.sessions;
    const sessionId = sessions[sessions.length - 1].id;
    day.slots.forEach((s, j) =>
      store().addSessionExercise(sessionId, {
        exerciseId: exerciseId(s.name),
        orderIndex: j,
        targetSets: s.sets,
        targetReps: s.reps,
        restSeconds: s.rest,
      }),
    );
  });

  store().setActiveProgram(program.id);
  return store().programs.find((p) => p.id === program.id)!;
}
