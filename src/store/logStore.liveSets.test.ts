import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionLog } from '@/types/logging';

// v1.20 (LimeLog#110 item 1, the owner's option (a)) — a workout is pushed as
// its sets are logged, and a device that pulled another device's workout keeps
// that copy current instead of freezing it at the first set.

const enqueue = vi.fn();
const cancel = vi.fn();
vi.mock('@/store/programStore', () => ({ useProgramStore: { getState: () => ({ exercises: [], activeProgram: null }) } }));
vi.mock('@/store/nexusStore', () => ({
  useNexusStore: { getState: () => ({ configured: true, syncEnabled: true, refreshPendingCount: () => {}, setLastPushAt: () => {} }) },
}));
vi.mock('@/lib/nexusSync', () => ({
  mapSessionLogToNexus: (log: SessionLog) => ({ sessionId: log.id, sets: log.sets.filter((s) => s.completed).length }),
}));
vi.mock('@/lib/outbox', () => ({ enqueue: (...a: unknown[]) => enqueue(...a), cancel: (...a: unknown[]) => cancel(...a) }));
vi.mock('@/lib/prDetection', () => ({ detectNewPRs: () => [], currentPR: () => null }));

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
const { flush: flushLivePushes } = await import('@/lib/livePush');

const store = () => useLogStore.getState();
const tick = async (logId: string, n: number, completed = true) => {
  store().logSet(logId, { exerciseId: 'sq', setNumber: n, weightKg: 100, reps: 5, rpe: null, completed });
  await vi.dynamicImportSettled();
};
const upserts = () => enqueue.mock.calls.filter(([k]) => k === 'upsert_workout_session');

/** A workout as nexusRecovery maps it from the cloud: finished, `n` sets. */
const fromCloud = (id: string, n: number): SessionLog => ({
  id, sessionTemplateId: '', programId: '',
  loggedAt: '2026-10-30T10:00:00Z', finalizedAt: '2026-10-30T10:00:00Z',
  perceivedFatigue: null,
  sets: Array.from({ length: n }, (_, i) => ({
    id: `${id}-s${i}`, sessionLogId: id, exerciseId: 'sq', setNumber: i + 1, weightKg: 100, reps: 5, rpe: null, completed: true,
  })),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  enqueue.mockClear();
  cancel.mockClear();
  useLogStore.setState({ sessionLogs: [], stallFlags: [], exercisePRs: [] });
});
afterEach(() => vi.useRealTimers());

describe('pushing a workout in progress', () => {
  it('pushes a completed set without Finish, 300 ms later', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1);
    expect(upserts()).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(upserts()).toEqual([['upsert_workout_session', { sessionId: log.id, sets: 1 }]]);
  });

  it('a burst of sets is one push, replacing any older one still queued', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1); vi.advanceTimersByTime(100);
    await tick(log.id, 2); vi.advanceTimersByTime(100);
    await tick(log.id, 3); vi.advanceTimersByTime(300);
    expect(upserts()).toEqual([['upsert_workout_session', { sessionId: log.id, sets: 3 }]]);
    const [kind, match] = cancel.mock.calls[0];
    expect(kind).toBe('upsert_workout_session');
    expect(match({ sessionId: log.id })).toBe(true);
    expect(match({ sessionId: 'other' })).toBe(false);
  });

  it('pushes nothing until a set is completed', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1, false);
    vi.advanceTimersByTime(1000);
    expect(upserts()).toHaveLength(0);
  });

  it('Finish within the window sends the finished workout only', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1);
    store().finalizeSession(log.id);
    vi.advanceTimersByTime(1000);
    expect(upserts()).toHaveLength(1);
  });

  it('Discard within the window sends the tombstone only', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1);
    store().discardSession(log.id);
    vi.advanceTimersByTime(1000);
    expect(upserts()).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledWith('delete_workout_session', { id: log.id });
  });

  it('going to the background pushes at once', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1);
    flushLivePushes();
    expect(upserts()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(upserts()).toHaveLength(1);
  });

  it('an edit to a finished workout is not a live push', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1);
    store().finalizeSession(log.id);
    enqueue.mockClear();
    const setId = store().sessionLogs[0].sets[0].id;
    store().updateSet(log.id, setId, { reps: 6 });
    await vi.dynamicImportSettled();
    vi.advanceTimersByTime(1000);
    expect(upserts()).toHaveLength(0);
  });
});

describe('a workout pulled from another device', () => {
  it('is added as the cloud\'s, then follows its later sets', () => {
    expect(store().recoverSessions([fromCloud('w', 1)])).toBe(1);
    expect(store().sessionLogs[0]).toMatchObject({ id: 'w', origin: 'cloud' });
    expect(store().recoverSessions([fromCloud('w', 4)])).toBe(1);
    expect(store().sessionLogs[0].sets).toHaveLength(4);
    expect(store().recoverSessions([fromCloud('w', 4)])).toBe(0);
  });

  it('goes when it is discarded there', () => {
    store().recoverSessions([fromCloud('w', 2), fromCloud('x', 1)]);
    expect(store().recoverSessions([fromCloud('x', 1)])).toBe(1);
    expect(store().sessionLogs.map((l) => l.id)).toEqual(['x']);
  });

  it("goes when it was the account's only workout", () => {
    store().recoverSessions([fromCloud('w', 2)]);
    expect(store().recoverSessions([])).toBe(1);
    expect(store().sessionLogs).toEqual([]);
  });

  it('never overwrites a workout made on this device', async () => {
    const log = store().startSession('t', 'p');
    await tick(log.id, 1);
    store().finalizeSession(log.id);
    const mine = store().sessionLogs[0];
    store().recoverSessions([{ ...fromCloud(log.id, 5) }, fromCloud('other', 1)]);
    expect(store().sessionLogs.find((l) => l.id === log.id)).toEqual(mine);
  });

  it('becomes this device\'s own once reopened with Undo', () => {
    store().recoverSessions([fromCloud('w', 2)]);
    store().unfinalizeSession('w');
    expect(store().sessionLogs[0].origin).toBeUndefined();
    store().recoverSessions([fromCloud('w', 6), fromCloud('y', 1)]);
    expect(store().sessionLogs.find((l) => l.id === 'w')!.sets).toHaveLength(2);
  });
});
