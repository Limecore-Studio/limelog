import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TFunction } from 'i18next';

// v1.22 (limelog#149, M part) — "Start an empty workout" from Today.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
// Never the real client: on Node 20 (CI) creating it throws (no WebSocket).
vi.mock('@/lib/supabase', () => ({ isNexusConfigured: false, supabase: {} }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@/store/nexusStore', () => ({
  useNexusStore: { getState: () => ({ configured: false, syncEnabled: false, refreshPendingCount: () => {}, setLastPushAt: () => {} }) },
}));
const { useProgramStore } = await import('@/store/programStore');
const { useLogStore } = await import('@/store/logStore');
const { startEmptyWorkout } = await import('./emptyWorkout');
const { sessionsForDay } = await import('./todaySessions');

const t = ((k: string) => k) as unknown as TFunction;
const friday = new Date(2026, 10, 20);
const programs = () => useProgramStore.getState().programs;

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  useProgramStore.setState({ programs: [], activeProgram: null });
  useLogStore.setState({ sessionLogs: [] });
});

describe('startEmptyWorkout', () => {
  it('with no program: creates "My training" with a default phase, active, and starts a session for today', () => {
    const logId = startEmptyWorkout(t, friday);
    const [p] = programs();
    expect(p.name).toBe('today.emptyProgramName');
    expect(p.phases.map((ph) => [ph.name, ph.weekStart, ph.weekEnd])).toEqual([['program.defaultPhaseName', 1, 4]]);
    expect(useProgramStore.getState().activeProgram?.id).toBe(p.id);
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0]).toMatchObject({ name: 'today.emptyWorkoutName', dayOfWeek: 5, exercises: [] });
    const log = useLogStore.getState().sessionLogs.find((l) => l.id === logId);
    expect(log).toMatchObject({ sessionTemplateId: p.sessions[0].id, programId: p.id, sets: [] });
  });

  it('with an active program: adds the session to it, in its current phase', () => {
    const p = useProgramStore.getState().createProgram({ name: 'Block', status: 'archived' });
    useProgramStore.getState().addPhase(p.id, { name: 'A', type: 'accumulation', orderIndex: 0, weekStart: 1, weekEnd: 4 });
    useProgramStore.getState().addPhase(p.id, { name: 'B', type: 'intensification', orderIndex: 1, weekStart: 5, weekEnd: 8 });
    const phaseB = programs()[0].phases[1].id;
    useProgramStore.getState().setActiveProgram(p.id);
    useProgramStore.setState({
      programs: programs().map((x) => ({ ...x, activePhaseId: phaseB })),
      activeProgram: { ...programs()[0], activePhaseId: phaseB },
    });
    startEmptyWorkout(t, friday);
    expect(programs()).toHaveLength(1);
    expect(programs()[0].sessions.map((s) => s.phaseId)).toEqual([phaseB]);
  });

  it('a second empty workout on another day reuses "My training"', () => {
    startEmptyWorkout(t, friday);
    useProgramStore.getState().deactivateProgram(programs()[0].id);
    startEmptyWorkout(t, new Date(2026, 10, 21));
    expect(programs()).toHaveLength(1);
    expect(programs()[0].sessions.map((s) => s.dayOfWeek)).toEqual([5, 6]);
    expect(useProgramStore.getState().activeProgram?.id).toBe(programs()[0].id);
  });
});

// Review of #168: an empty workout that ends with nothing added must not leave
// a session (and "My training") behind, to be offered every week.
describe('an empty workout that ends with no exercise added', () => {
  const sessions = () => programs().flatMap((p) => p.sessions);

  it('discarded: its session and the "My training" it made are removed', () => {
    const logId = startEmptyWorkout(t, friday);
    useLogStore.getState().discardSession(logId);
    expect(programs()).toEqual([]);
    expect(useProgramStore.getState().activeProgram).toBeNull();
  });

  it('finished: the session is retired (History still names it), never offered again', () => {
    const logId = startEmptyWorkout(t, friday);
    useLogStore.getState().finalizeSession(logId);
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0].retired).toBe(true);
    const active = useProgramStore.getState().activeProgram;
    expect(sessionsForDay(active, 5, active?.phases[0].id)).toEqual([]);
  });

  it('with an exercise added, the session stays, as planned', () => {
    const logId = startEmptyWorkout(t, friday);
    const sessionId = sessions()[0].id;
    useProgramStore.getState().addSessionExercise(sessionId, { exerciseId: 'bench', orderIndex: 0, targetSets: 3, targetReps: '8-10' });
    useLogStore.getState().discardSession(logId);
    expect(sessions().map((s) => [s.id, !!s.retired])).toEqual([[sessionId, false]]);
  });

  it('in the user’s own program: only the session goes, never the program or its other sessions', () => {
    const p = useProgramStore.getState().createProgram({ name: 'Block', status: 'archived' });
    useProgramStore.getState().addPhase(p.id, { name: 'A', type: 'accumulation', orderIndex: 0, weekStart: 1, weekEnd: 4 });
    useProgramStore.getState().setActiveProgram(p.id);
    const logId = startEmptyWorkout(t, friday);
    useLogStore.getState().discardSession(logId);
    expect(programs().map((x) => [x.name, x.sessions.length])).toEqual([['Block', 0]]);
  });
});

