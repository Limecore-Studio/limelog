import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolvePhase, phaseSessions } from '@/lib/todaySessions';

// v1.18.1 (LimeLog#73) — deleting a phase. It used to leave the phase's
// sessions behind (invisible in the editor, still scheduling reminders) and an
// activePhaseId naming nothing. Today then showed "Next phase" from the first
// phase, but advancePhase returned null, so the button did nothing.

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

/** A program with three phases, each with one session, made active. */
function setUp() {
  useProgramStore.setState({ programs: [], activeProgram: null });
  const s = useProgramStore.getState();
  const prog = s.createProgram({ name: 'Block', status: 'active' } as never);
  s.setActiveProgram(prog.id);
  ['Accumulation', 'Intensification', 'Peaking'].forEach((name, i) =>
    s.addPhase(prog.id, { name, type: 'accumulation', orderIndex: i, weekStart: 1, weekEnd: 4 }),
  );
  const phases = useProgramStore.getState().programs[0].phases;
  phases.forEach((ph, i) => s.addSession({ phaseId: ph.id, name: `${ph.name} day`, dayOfWeek: 3, orderIndex: i }));
  return { id: prog.id, phases };
}

const active = () => useProgramStore.getState().activeProgram!;

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
});

describe('deletePhase', () => {
  it('moves an active phase that is deleted on to the one after it', () => {
    const { id, phases } = setUp();
    useProgramStore.getState().advancePhase(id); // into Intensification
    useProgramStore.getState().deletePhase(id, phases[1].id);
    expect(active().activePhaseId).toBe(phases[2].id);
    expect(resolvePhase(active()).current?.name).toBe('Peaking');
  });

  it('keeps Next phase working: it advances from the phase that took over', () => {
    const { id, phases } = setUp();
    const programs = useProgramStore.getState().programs.map((p) => ({ ...p, activePhaseId: phases[0].id }));
    useProgramStore.setState({ programs, activeProgram: programs[0] });
    useProgramStore.getState().deletePhase(id, phases[0].id);
    expect(resolvePhase(active()).next?.id).toBe(phases[2].id);
    expect(useProgramStore.getState().advancePhase(id)?.id).toBe(phases[2].id);
  });

  it('falls back to the phase before when the active phase was the last', () => {
    const { id, phases } = setUp();
    useProgramStore.getState().advancePhase(id);
    useProgramStore.getState().advancePhase(id); // into Peaking
    useProgramStore.getState().deletePhase(id, phases[2].id);
    expect(active().activePhaseId).toBe(phases[1].id);
  });

  it('deletes the phase\'s sessions, so none are left to remind about', () => {
    const { id, phases } = setUp();
    useProgramStore.getState().deletePhase(id, phases[1].id);
    expect(active().sessions.map((x) => x.name)).toEqual(['Accumulation day', 'Peaking day']);
    expect(phaseSessions(active(), resolvePhase(active()).current?.id).map((x) => x.name)).toEqual(['Accumulation day']);
  });

  it('keeps a session with workouts logged, but never offers it again (review)', () => {
    const { id, phases } = setUp();
    const logged = active().sessions.find((x) => x.phaseId === phases[1].id)!;
    useProgramStore.getState().deletePhase(id, phases[1].id, new Set([logged.id]));
    expect(active().sessions.map((x) => x.name)).toContain('Intensification day');
    expect(phaseSessions(active(), resolvePhase(active()).current?.id).map((x) => x.name)).toEqual(['Accumulation day']);
    // Not even when the current phase has nothing and every session is offered.
    const programs = useProgramStore.getState().programs.map((p) => ({
      ...p,
      sessions: p.sessions.filter((x) => x.phaseId !== phases[0].id),
    }));
    useProgramStore.setState({ programs, activeProgram: programs[0] });
    expect(phaseSessions(active(), resolvePhase(active()).current?.id).map((x) => x.name)).toEqual(['Peaking day']);
  });

  it('leaves the active phase alone when another phase is deleted', () => {
    const { id, phases } = setUp();
    useProgramStore.getState().advancePhase(id);
    useProgramStore.getState().deletePhase(id, phases[0].id);
    expect(active().activePhaseId).toBe(phases[1].id);
  });
});

describe('advancePhase', () => {
  it('advances from what Today shows when activePhaseId names no phase', () => {
    // Data an older build's deletePhase left behind.
    const { id, phases } = setUp();
    const programs = useProgramStore.getState().programs.map((p) => ({ ...p, activePhaseId: 'deleted' }));
    useProgramStore.setState({ programs, activeProgram: programs[0] });
    expect(resolvePhase(active()).next?.id).toBe(phases[1].id);
    expect(useProgramStore.getState().advancePhase(id)?.id).toBe(phases[1].id);
  });

  it('does nothing on the last phase', () => {
    const { id } = setUp();
    useProgramStore.getState().advancePhase(id);
    useProgramStore.getState().advancePhase(id);
    expect(useProgramStore.getState().advancePhase(id)).toBeNull();
  });
});
