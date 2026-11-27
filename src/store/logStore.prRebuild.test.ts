import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionLog } from '@/types/logging';

// v1.22 (limelog#119) — a recovery or live pull rebuilds PRs for the workouts
// it adds, without celebrating or pushing them. The real store and the real
// PR detection; the outbox is a spy.

process.env.TZ = 'UTC';
const enqueue = vi.fn();
vi.mock('@/store/programStore', () => ({
  useProgramStore: { getState: () => ({ exercises: [{ id: 'sq', name: 'Squat' }], activeProgram: null, programs: [], releaseEmptyStart: () => {} }) },
}));
vi.mock('@/store/nexusStore', () => ({
  useNexusStore: { getState: () => ({ configured: true, syncEnabled: true, userId: 'u1', refreshPendingCount: () => {}, setLastPushAt: () => {} }) },
}));
vi.mock('@/lib/nexusSync', () => ({ mapSessionLogToNexus: (log: SessionLog) => ({ sessionId: log.id }) }));
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

const fromCloud = (id: string, at: string, weightKg: number, exerciseId = 'sq'): SessionLog => ({
  id, sessionTemplateId: '', programId: '', loggedAt: at, finalizedAt: at, perceivedFatigue: null,
  sets: [{ id: `${id}-s0`, sessionLogId: id, exerciseId, setNumber: 1, weightKg, reps: 5, rpe: null, completed: true }],
});

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  enqueue.mockClear();
  useLogStore.setState({ sessionLogs: [], stallFlags: [], exercisePRs: [], lastCelebratedPRs: null });
});

describe('PRs after a recovery pull (limelog#119)', () => {
  it('rebuilds them from the restored history, silently and locally', () => {
    store().recoverSessions([
      fromCloud('a', '2026-10-01T10:00:00Z', 80),
      fromCloud('b', '2026-10-08T10:00:00Z', 100),
      fromCloud('c', '2026-10-15T10:00:00Z', 90, 'rec:front-squat'),
    ]);
    expect(store().currentPRFor('sq')?.weightKg).toBe(100);
    expect(store().currentPRFor('rec:front-squat')?.exerciseName).toBe('front squat');
    expect(store().lastCelebratedPRs).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the first workout after a reinstall is measured against the real best', () => {
    store().recoverSessions([fromCloud('a', '2026-10-01T10:00:00Z', 100)]);
    const log = store().startSession('t', 'p');
    store().logSet(log.id, { exerciseId: 'sq', setNumber: 1, weightKg: 70, reps: 5, rpe: null, completed: true });
    store().finalizeSession(log.id);
    expect(store().lastCelebratedPRs).toBeNull();
  });

  it('drops the rows of a cloud workout that was discarded elsewhere', () => {
    store().recoverSessions([fromCloud('a', '2026-10-01T10:00:00Z', 80), fromCloud('b', '2026-10-08T10:00:00Z', 100)]);
    store().recoverSessions([fromCloud('a', '2026-10-01T10:00:00Z', 80)]);
    expect(store().currentPRFor('sq')?.weightKg).toBe(80);
  });

  it('a pull that changes nothing leaves the rows as they are', () => {
    store().recoverSessions([fromCloud('a', '2026-10-01T10:00:00Z', 80)]);
    const before = store().exercisePRs;
    store().recoverSessions([fromCloud('a', '2026-10-01T10:00:00Z', 80)]);
    expect(store().exercisePRs).toBe(before);
  });
});
