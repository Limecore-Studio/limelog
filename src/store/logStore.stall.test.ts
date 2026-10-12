import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionLog } from '@/types/logging';

// v1.18.1 (LimeLog#75) — the stall flag is decided when a workout is finished,
// from its completed sets. It ran on every set tick against the workout in
// progress, unfinished rows included: after two flat sessions the first set of
// a third flagged a plateau, and the flag stayed when the lifter went on to
// add weight.

vi.mock('@/store/programStore', () => ({ useProgramStore: { getState: () => ({ exercises: [], activeProgram: null }) } }));
vi.mock('@/store/nexusStore', () => ({ useNexusStore: { getState: () => ({ configured: false, syncEnabled: false }) } }));
vi.mock('@/lib/nexusSync', () => ({ mapSessionLogToNexus: vi.fn() }));
vi.mock('@/lib/outbox', () => ({ enqueue: vi.fn() }));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

vi.stubGlobal('localStorage', storage());
const { useLogStore } = await import('./logStore');

/** A finished workout: five completed sets of squat at `kg`. */
const flat = (id: string, day: number, kg: number): SessionLog => ({
  id, sessionTemplateId: 't', programId: 'p',
  loggedAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z`,
  finalizedAt: `2026-01-${String(day).padStart(2, '0')}T11:00:00Z`,
  perceivedFatigue: null,
  sets: [1, 2, 3, 4, 5].map((n) => ({
    id: `${id}${n}`, sessionLogId: id, exerciseId: 'sq', setNumber: n, weightKg: kg, reps: 5, rpe: null, completed: true,
  })),
});

const tick = (logId: string, setNumber: number, weightKg: number, completed = true) =>
  useLogStore.getState().logSet(logId, { exerciseId: 'sq', setNumber, weightKg, reps: 5, rpe: null, completed });

const flags = () => useLogStore.getState().stallFlags;

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  // Two flat weeks at 100 kg.
  useLogStore.setState({ sessionLogs: [flat('a', 1, 100), flat('b', 8, 100)], stallFlags: [], exercisePRs: [] });
});

describe('stall detection', () => {
  it('does not count a workout still in progress', () => {
    const log = useLogStore.getState().startSession('t', 'p');
    tick(log.id, 1, 100);
    useLogStore.getState().checkAndFlagStalls('sq');
    expect(flags()).toEqual([]);
  });

  it('raises nothing when the third workout goes on to progress', () => {
    const log = useLogStore.getState().startSession('t', 'p');
    tick(log.id, 1, 100);
    tick(log.id, 2, 105);
    useLogStore.getState().finalizeSession(log.id);
    expect(flags()).toEqual([]);
  });

  it('flags a third flat workout when it is finished', () => {
    const log = useLogStore.getState().startSession('t', 'p');
    [1, 2, 3].forEach((n) => tick(log.id, n, 100));
    expect(flags()).toEqual([]);
    useLogStore.getState().finalizeSession(log.id);
    expect(flags()).toHaveLength(1);
    expect(flags()[0]).toMatchObject({ exerciseId: 'sq', flagType: 'weight_plateau', resolved: false });
  });

  it('ignores a heavier set that was never completed', () => {
    const log = useLogStore.getState().startSession('t', 'p');
    [1, 2, 3].forEach((n) => tick(log.id, n, 100));
    tick(log.id, 4, 110, false);
    useLogStore.getState().finalizeSession(log.id);
    expect(flags()).toHaveLength(1);
  });
});
