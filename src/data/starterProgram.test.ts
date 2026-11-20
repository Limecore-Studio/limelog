import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TFunction } from 'i18next';

// v1.22 (limelog#149) — the full-body starter offered on first launch.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
const { useProgramStore } = await import('@/store/programStore');
const { createStarterProgram, STARTER_DAYS } = await import('./starterProgram');
const { BUILTIN_EXERCISES } = await import('./builtinExercises');
const { sessionsForDay, resolvePhase } = await import('@/lib/todaySessions');

const t = ((k: string) => k) as unknown as TFunction;
const thursday = new Date(2026, 10, 19); // a Thursday

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  useProgramStore.setState({ programs: [], activeProgram: null, exercises: [] });
});

describe('createStarterProgram', () => {
  it('uses only built-in library exercises', () => {
    const names = new Set(BUILTIN_EXERCISES.map((e) => e.name));
    for (const d of STARTER_DAYS) for (const s of d.slots) expect(names.has(s.name), s.name).toBe(true);
  });

  it('is created active, with day A today, so Today can start it at once', async () => {
    const p = await createStarterProgram(t, thursday);
    const s = useProgramStore.getState();
    expect(s.activeProgram?.id).toBe(p.id);
    expect(p.sessions.map((x) => x.dayOfWeek)).toEqual([4, 6, 1]); // Thu, Sat, Mon
    const today = sessionsForDay(s.activeProgram, 4, resolvePhase(s.activeProgram).current?.id);
    expect(today.map((x) => x.name)).toEqual(['today.starterDayA']);
  });

  it('every slot points at an exercise in the store', async () => {
    const p = await createStarterProgram(t, thursday);
    const ids = new Set(useProgramStore.getState().exercises.map((e) => e.id));
    const slots = p.sessions.flatMap((x) => x.exercises);
    expect(slots).toHaveLength(11);
    for (const se of slots) expect(ids.has(se.exerciseId)).toBe(true);
  });

  it('brings back a built-in the user had archived, rather than a second copy', async () => {
    const bench = useProgramStore.getState().addExercise(BUILTIN_EXERCISES.find((e) => e.name === 'Barbell Bench Press')!);
    useProgramStore.getState().deleteExercise(bench.id, true);
    const p = await createStarterProgram(t, thursday);
    expect(p.sessions[0].exercises.some((se) => se.exerciseId === bench.id)).toBe(true);
    expect(useProgramStore.getState().exercises.filter((e) => e.name === 'Barbell Bench Press')).toHaveLength(1);
  });
});
