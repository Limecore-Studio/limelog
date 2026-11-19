import { describe, it, expect, beforeEach, vi } from 'vitest';
import { phaseSessions, sessionsForDay } from '@/lib/todaySessions';
import { exerciseInUse, sessionHasWorkouts } from '@/lib/exerciseRefs';
import type { SessionLog } from '@/types/logging';

// v1.22 (limelog#121, #122) — deleting a session template or a library
// exercise was one tap and orphaned history: an unfinished workout could not
// be opened, past ones read "Unknown session" / "Unknown exercise", and a
// re-push sent "Unknown exercise" to the cloud. The UI now asks first; the
// store keeps what history refers to (retired / archived) and drops the rest.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

vi.stubGlobal('localStorage', storage());
const { useProgramStore } = await import('./programStore');
const store = () => useProgramStore.getState();

function setUp() {
  useProgramStore.setState({ programs: [], activeProgram: null });
  const prog = store().createProgram({ name: 'Block', status: 'active' } as never);
  store().setActiveProgram(prog.id);
  store().addPhase(prog.id, { name: 'Acc', type: 'accumulation', orderIndex: 0, weekStart: 1, weekEnd: 4 });
  const phase = store().programs[0].phases[0];
  store().addSession({ phaseId: phase.id, name: 'Push', dayOfWeek: 3, orderIndex: 0 });
  store().addSession({ phaseId: phase.id, name: 'Pull', dayOfWeek: 3, orderIndex: 1 });
  const [push, pull] = store().programs[0].sessions;
  return { phase, push, pull };
}

const log = (over: Partial<SessionLog>): SessionLog =>
  ({ id: 'l', loggedAt: '2026-11-01T10:00:00Z', perceivedFatigue: null, sets: [], ...over }) as SessionLog;

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
});

describe('deleteSession (limelog#121)', () => {
  it('a session with workouts is retired: still found by id, never offered', () => {
    const { phase, push, pull } = setUp();
    store().deleteSession(push.id, true);
    const prog = store().activeProgram!;
    expect(prog.sessions.find((s) => s.id === push.id)).toMatchObject({ name: 'Push', retired: true });
    expect(phaseSessions(prog, phase.id).map((s) => s.id)).toEqual([pull.id]);
    expect(sessionsForDay(prog, 3, phase.id).map((s) => s.id)).toEqual([pull.id]);
  });

  it('a session with no workouts is removed', () => {
    const { push } = setUp();
    store().deleteSession(push.id, false);
    expect(store().activeProgram!.sessions.find((s) => s.id === push.id)).toBeUndefined();
  });

  it('sessionHasWorkouts counts finished and unfinished workouts', () => {
    expect(sessionHasWorkouts('s1', [log({ sessionTemplateId: 's1' })])).toBe(true);
    expect(sessionHasWorkouts('s1', [log({ sessionTemplateId: 's1', finalizedAt: '2026-11-01T11:00:00Z' })])).toBe(true);
    expect(sessionHasWorkouts('s1', [log({ sessionTemplateId: 's2' })])).toBe(false);
  });
});

describe('deleteExercise (limelog#122)', () => {
  const bench = { name: 'Bench Press', movementPattern: 'horizontal_push', primaryMuscle: 'chest', equipment: 'barbell', isBilateral: true } as never;

  it('an exercise in use is archived and still resolves by id', () => {
    useProgramStore.setState({ exercises: [] });
    const ex = store().addExercise(bench);
    store().deleteExercise(ex.id, true);
    expect(store().exercises.find((e) => e.id === ex.id)).toMatchObject({ name: 'Bench Press', archived: true });
  });

  it('adding it again brings the same row back, so history links up', () => {
    useProgramStore.setState({ exercises: [] });
    const ex = store().addExercise(bench);
    store().deleteExercise(ex.id, true);
    const again = store().addExercise(bench);
    expect(again.id).toBe(ex.id);
    expect(again.archived).toBeUndefined();
    expect(store().exercises).toHaveLength(1);
  });

  it('an exercise nothing refers to is removed', () => {
    useProgramStore.setState({ exercises: [] });
    const ex = store().addExercise(bench);
    store().deleteExercise(ex.id, false);
    expect(store().exercises).toEqual([]);
  });

  it('exerciseInUse sees program slots, logged sets and swaps', () => {
    const { push } = setUp();
    store().addSessionExercise(push.id, { exerciseId: 'bench', orderIndex: 0, sets: 3, targetReps: '5' } as never);
    const programs = store().programs;
    expect(exerciseInUse('bench', programs, [])).toBe(true);
    expect(exerciseInUse('row', programs, [log({ sets: [{ exerciseId: 'row' }] as SessionLog['sets'] })])).toBe(true);
    expect(exerciseInUse('dip', programs, [log({ exerciseSwaps: { x: 'dip' } })])).toBe(true);
    expect(exerciseInUse('curl', programs, [log({})])).toBe(false);
  });
});
