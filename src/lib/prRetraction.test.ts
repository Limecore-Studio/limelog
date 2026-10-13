import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';
import type { ExercisePR, SessionLog, SetLog } from '@/types/logging';

// v1.18.1 (LimeLog#72) — a PR goes with the finished workout it was detected
// in. Undo reopens the workout and Discard deletes it, and both used to leave
// its PR rows in place for good, locally and in `exercise_prs`: a typo'd
// 1000 kg fixed after Undo stayed the PR every later lift was measured against.
// The real log store and the real outbox; only the Supabase client and storage
// are stand-ins (the workoutTombstone.test.ts pattern).

const USER = 'user-1';
type Write = { table: string; op: 'update' | 'delete' | 'upsert'; row?: unknown; eq?: [string, unknown] };

const holder = vi.hoisted(() => ({ client: null as unknown as ReturnType<typeof makeClient> }));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  get supabase() {
    return holder.client;
  },
}));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function makeClient() {
  const base = fakeClient({});
  const writes: Write[] = [];
  const ok = { error: null };
  return {
    writes,
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from(table: string) {
      return Object.assign(base.from(table), {
        delete: () => ({
          eq: (col: string, val: unknown) => {
            writes.push({ table, op: 'delete', eq: [col, val] });
            return Promise.resolve(ok);
          },
        }),
      });
    },
  };
}

// The outbox migrates a legacy queue key on load, so storage must exist first.
vi.stubGlobal('localStorage', storage());
const outbox = await import('./outbox');
const { useLogStore } = await import('@/store/logStore');
const { useNexusStore } = await import('@/store/nexusStore');

const LOG = '0b7d6f1c-2a4e-4c9a-8e3f-2d5b1a7c9e02';
const OLDER = '9e3f0b7d-6f1c-4a2e-8c9a-1a7c2d5b9e03';

const pr = (id: string, sessionId: string, oneRepMaxKg: number): ExercisePR => ({
  id, exerciseId: 'squat', exerciseName: 'Squat', weightKg: 100, reps: 5, oneRepMaxKg,
  sessionId, date: '2026-09-25', createdAt: '2026-09-25T11:00:00Z',
});

const workout = (sets: Partial<SetLog>[], over: Partial<SessionLog> = {}): SessionLog => ({
  id: LOG, sessionTemplateId: 't', programId: 'p', loggedAt: '2026-09-25T10:00:00Z',
  perceivedFatigue: null,
  sets: sets.map((s, i) => ({
    id: `s${i}`, sessionLogId: LOG, exerciseId: 'squat', setNumber: i + 1,
    weightKg: 100, reps: 5, rpe: null, completed: true, ...s,
  })),
  ...over,
});

const queued = () =>
  JSON.parse(localStorage.getItem('limelog-outbox') ?? '[]').map((i: { kind: string; payload: unknown }) => [i.kind, i.payload]);

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('navigator', { onLine: false }); // enqueue must not drain on its own
  holder.client = makeClient();
  useNexusStore.setState({ configured: true, syncEnabled: true });
  useLogStore.setState({
    sessionLogs: [workout([], { finalizedAt: '2026-09-25T11:00:00Z' })],
    // The phantom: a 1000 kg typo finished, then undone to fix it.
    exercisePRs: [pr('phantom', LOG, 1166.67), pr('real', OLDER, 112.5)],
    lastCelebratedPRs: [pr('phantom', LOG, 1166.67)],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('undoing a finished workout', () => {
  it('drops its PRs, so the current PR falls back to the best one left', () => {
    useLogStore.getState().unfinalizeSession(LOG);
    const s = useLogStore.getState();
    expect(s.exercisePRs.map((p) => p.id)).toEqual(['real']);
    expect(s.currentPRFor('squat')?.id).toBe('real');
    expect(s.lastCelebratedPRs).toBeNull();
    expect(JSON.parse(localStorage.getItem('wt_exercise_prs') ?? '[]').map((p: ExercisePR) => p.id)).toEqual(['real']);
  });

  it('queues the deletion of its PR rows upstream', () => {
    useLogStore.getState().unfinalizeSession(LOG);
    expect(queued()).toEqual([['delete_exercise_pr', { id: 'phantom' }]]);
  });

  it('finishing again detects the PR afresh: one row, not two', () => {
    useLogStore.setState({ sessionLogs: [workout([{ weightKg: 100, reps: 4 }])], exercisePRs: [] });
    useLogStore.getState().finalizeSession(LOG);
    expect(useLogStore.getState().exercisePRs).toHaveLength(1);
    useLogStore.getState().unfinalizeSession(LOG);
    expect(useLogStore.getState().exercisePRs).toEqual([]);
    useLogStore.getState().finalizeSession(LOG);
    const prs = useLogStore.getState().exercisePRs;
    expect(prs).toHaveLength(1);
    expect(prs[0].oneRepMaxKg).toBe(109.09);
  });
});

describe('discarding a workout', () => {
  it('drops its PRs and queues their deletion beside the workout tombstone', () => {
    useLogStore.getState().discardSession(LOG);
    expect(useLogStore.getState().exercisePRs.map((p) => p.id)).toEqual(['real']);
    expect(queued()).toContainEqual(['delete_exercise_pr', { id: 'phantom' }]);
    expect(queued()).toContainEqual(['delete_workout_session', { id: LOG }]);
  });

  it('with sync off, still drops them locally and queues nothing', () => {
    useNexusStore.setState({ configured: true, syncEnabled: false });
    useLogStore.getState().discardSession(LOG);
    expect(useLogStore.getState().exercisePRs.map((p) => p.id)).toEqual(['real']);
    expect(queued()).toEqual([]);
  });
});

describe('the queued deletion', () => {
  it('deletes the exercise_prs row by id', async () => {
    useLogStore.getState().unfinalizeSession(LOG);
    vi.stubGlobal('navigator', { onLine: true });
    await outbox.drain();
    expect(holder.client.writes).toEqual([{ table: 'exercise_prs', op: 'delete', eq: ['id', 'phantom'] }]);
    expect(queued()).toEqual([]);
  });
});

describe('an insert still queued when its PR is retracted (review)', () => {
  it('is cancelled, so a retry moved behind the delete cannot bring the PR back', () => {
    localStorage.setItem('limelog-outbox', JSON.stringify([
      // Hit MAX_ATTEMPTS: the next failure moves it behind anything queued now.
      { id: 'q1', createdAt: '2026-09-25T11:00:00Z', kind: 'upsert_exercise_pr', payload: { id: 'phantom' }, attempts: 4 },
      { id: 'q2', createdAt: '2026-09-25T11:00:00Z', kind: 'upsert_exercise_pr', payload: { id: 'real' }, attempts: 0 },
    ]));
    useLogStore.getState().unfinalizeSession(LOG);
    expect(queued()).toEqual([
      ['upsert_exercise_pr', { id: 'real' }],
      ['delete_exercise_pr', { id: 'phantom' }],
    ]);
  });
});
