import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';

// v1.16 (limelog#32, registry P6) — discarding a workout tombstones it in the
// cloud, and recovery never brings a tombstoned workout back. The real outbox,
// the real log store and the real recovery pull; only the Supabase client and
// storage are stand-ins.

const USER = 'user-1';
type Write = { table: string; op: 'update' | 'delete'; row?: Record<string, unknown>; eq?: [string, unknown] };

const holder = vi.hoisted(() => ({ client: null as unknown as ReturnType<typeof makeClient> }));
// v1.18.1 (LimeLog#92) — accountOwner mirrors the owner record into Preferences.
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
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

/** The shared read-side fake, signed in as USER, recording writes. */
function makeClient(tables: Record<string, Record<string, unknown>[]> = {}) {
  const base = fakeClient(tables);
  const writes: Write[] = [];
  const ok = { error: null };
  return {
    requests: base.requests,
    writes,
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from(table: string) {
      return Object.assign(base.from(table), {
        update: (row: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => {
            writes.push({ table, op: 'update', row, eq: [col, val] });
            return Promise.resolve(ok);
          },
        }),
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
const { pullWorkoutsFromCloud } = await import('./nexusRecovery');

const LOG = '6f1c2a4e-0b7d-4c9a-8e3f-2d5b1a7c9e01';

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  // v1.18.1 (LimeLog#88) — the outbox sends only for the recorded owner.
  localStorage.setItem('limelog.dataOwner', USER);
  vi.stubGlobal('navigator', { onLine: false }); // enqueue must not drain on its own
  holder.client = makeClient();
  useLogStore.setState({
    sessionLogs: [{ id: LOG, sessionTemplateId: 't', programId: 'p', loggedAt: '2026-09-25T10:00:00Z', sets: [] } as never],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discarding a workout', () => {
  it('queues a cloud tombstone when sync is on', () => {
    useNexusStore.setState({ configured: true, syncEnabled: true });
    useLogStore.getState().discardSession(LOG);
    const queued = JSON.parse(localStorage.getItem('limelog-outbox') ?? '[]');
    expect(queued.map((i: { kind: string; payload: unknown }) => [i.kind, i.payload])).toEqual([
      ['delete_workout_session', { id: LOG }],
    ]);
  });

  it('queues nothing when sync is off, and still keeps the local tombstone', () => {
    useNexusStore.setState({ configured: true, syncEnabled: false });
    useLogStore.getState().discardSession(LOG);
    expect(JSON.parse(localStorage.getItem('limelog-outbox') ?? '[]')).toEqual([]);
    expect(useLogStore.getState().sessionLogs).toEqual([]);
  });

  it('the queued delete writes a tombstone and never a DELETE', async () => {
    useNexusStore.setState({ configured: true, syncEnabled: true });
    useLogStore.getState().discardSession(LOG);
    vi.stubGlobal('navigator', { onLine: true });
    await outbox.drain();

    const { writes } = holder.client;
    expect(writes.filter((w) => w.op === 'delete')).toEqual([]);
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(w.table).toBe('workout_sessions');
    expect(w.eq).toEqual(['id', LOG]);
    expect(Object.keys(w.row ?? {}).sort()).toEqual(['deleted_at', 'updated_at']);
    expect(w.row?.deleted_at).toBe(w.row?.updated_at);
  });
});

describe('recovery skips tombstoned workouts', () => {
  const session = (id: string, deleted: boolean) => ({
    id, user_id: USER, session_type: 'strength', date: '2026-09-20T10:00:00Z',
    deleted_at: deleted ? '2026-09-21T10:00:00Z' : null,
  });

  it('restores the live workout and not the discarded one', async () => {
    const live = crypto.randomUUID();
    const gone = crypto.randomUUID();
    holder.client = makeClient({ workout_sessions: [session(live, false), session(gone, true)] });
    const restored = await pullWorkoutsFromCloud([]);
    expect(restored.map((l) => l.id)).toEqual([live]);
  });

  it('asks the server for live sessions only', async () => {
    await pullWorkoutsFromCloud([]);
    const req = holder.client.requests.find((r) => r.table === 'workout_sessions');
    expect(req?.filters).toContainEqual(['is', 'deleted_at', null]);
  });
});
