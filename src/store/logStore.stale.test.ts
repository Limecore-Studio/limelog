import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionLog } from '@/types/logging';

// v1.22 (limelog#120) — a workout pushed in progress and never finished used to
// strand: in the cloud and on other devices as done, but off this device's
// History and unreachable after a week. The real store and PR detection.

process.env.TZ = 'UTC';
const enqueue = vi.fn();
vi.mock('@/store/programStore', () => ({
  useProgramStore: { getState: () => ({ exercises: [{ id: 'sq', name: 'Squat' }], activeProgram: null, releaseEmptyStart: () => {} }) },
}));
vi.mock('@/store/nexusStore', () => ({
  useNexusStore: { getState: () => ({ configured: true, syncEnabled: true, refreshPendingCount: () => {}, setLastPushAt: () => {} }) },
}));
vi.mock('@/lib/nexusSync', () => ({ mapSessionLogToNexus: (log: SessionLog) => ({ sessionId: log.id, finalizedAt: log.finalizedAt }) }));
vi.mock('@/lib/outbox', () => ({ enqueue: (...a: unknown[]) => enqueue(...a), cancel: () => 0 }));

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
const store = () => useLogStore.getState();

const unfinished = (id: string, loggedAt: string, weightKg = 100): SessionLog => ({
  id, sessionTemplateId: 't', programId: 'p', loggedAt, perceivedFatigue: null,
  sets: [{ id: `${id}-s0`, sessionLogId: id, exerciseId: 'sq', setNumber: 1, weightKg, reps: 5, rpe: null, completed: true }],
});

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  enqueue.mockClear();
  useLogStore.setState({ sessionLogs: [], stallFlags: [], exercisePRs: [], lastCelebratedPRs: null });
});

describe('finishStaleWorkouts (limelog#120)', () => {
  const now = new Date('2026-11-19T12:00:00Z');

  it('finishes a week-old workout as of its start, quietly, and pushes it', () => {
    useLogStore.setState({ sessionLogs: [unfinished('old', '2026-11-10T18:00:00Z'), unfinished('new', '2026-11-18T18:00:00Z')] });
    expect(store().finishStaleWorkouts(now)).toBe(1);
    const old = store().sessionLogs.find((l) => l.id === 'old')!;
    expect(old.finalizedAt).toBe('2026-11-10T18:00:00Z');
    expect(store().sessionLogs.find((l) => l.id === 'new')!.finalizedAt).toBeUndefined();
    // Its PR is recorded but not celebrated on app open.
    expect(store().currentPRFor('sq')?.sessionId).toBe('old');
    expect(store().lastCelebratedPRs).toBeNull();
    expect(enqueue).toHaveBeenCalledWith('upsert_workout_session', { sessionId: 'old', finalizedAt: '2026-11-10T18:00:00Z' });
  });

  it('a second run finds nothing to do', () => {
    useLogStore.setState({ sessionLogs: [unfinished('old', '2026-11-10T18:00:00Z')] });
    store().finishStaleWorkouts(now);
    enqueue.mockClear();
    expect(store().finishStaleWorkouts(now)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Finish by the user still celebrates', () => {
    useLogStore.setState({ sessionLogs: [unfinished('w', '2026-11-19T11:00:00Z')] });
    store().finalizeSession('w');
    expect(store().lastCelebratedPRs).toHaveLength(1);
  });
});
