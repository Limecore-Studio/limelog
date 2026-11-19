import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NexusWorkoutPayload } from './nexusSync';

// v1.22 (limelog#118) — Finish/Discard cancel a workout push that is still in
// flight. When that push then failed, the outbox wrote it back from memory,
// and once at MAX_ATTEMPTS it landed after the final push: the LWW guard kept
// the session row, but its set clean-up deleted the finished workout's later
// sets. The real outbox and the real pushWorkoutToNexus; the Supabase client
// is a small stand-in that keeps rows and applies set_updated_at's LWW rule.

type Row = Record<string, unknown>;
const server = vi.hoisted(() => ({
  sessions: new Map<string, Row>(),
  sets: new Map<string, Row>(),
  /** When set, the next session upsert waits on it and fails if it rejects. */
  gate: null as Promise<void> | null,
  /** Follow-up reads of a session's stored stamp. */
  reads: 0,
}));

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('./supabase', () => {
  const ok = { data: null, error: null };
  function upsertSession(row: Row) {
    const run = async () => {
      const gate = server.gate;
      server.gate = null;
      if (gate) await gate;
      const old = server.sessions.get(row.id as string);
      // set_updated_at, step 3: an older stamp keeps the stored row (returns
      // OLD), and zz_skip_noop_update then skips it: RETURNING is empty.
      if (old && String(row.updated_at) < String(old.updated_at)) return { data: [], error: null };
      // zz_skip_noop_update also skips a write that changes only updated_at.
      const same = (r: Row) => JSON.stringify({ ...r, updated_at: null });
      if (old && same(old) === same(row)) return { data: [], error: null };
      server.sessions.set(row.id as string, row);
      return { data: [row], error: null };
    };
    return { select: () => run().catch((e: Error) => ({ data: null, error: { message: e.message } })) };
  }
  function deleteSets() {
    const f: { session?: unknown; keep?: string[] } = {};
    const chain = {
      eq: (_c: string, v: unknown) => ((f.session = v), chain),
      not: (_c: string, _op: string, list: string) => ((f.keep = list.slice(1, -1).split(',')), chain),
      then: (r: (v: unknown) => unknown) => {
        for (const [id, s] of server.sets) {
          if (s.session_id === f.session && !(f.keep ?? []).includes(id)) server.sets.delete(id);
        }
        return Promise.resolve(ok).then(r);
      },
    };
    return chain;
  }
  return {
    isNexusConfigured: true,
    supabase: {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
      from: (table: string) => ({
        select: () => ({
          eq: (_c: string, id: string) => {
            server.reads++;
            const r = server.sessions.get(id);
            return Promise.resolve({ data: r ? [{ updated_at: r.updated_at }] : [], error: null });
          },
        }),
        upsert: (rows: Row | Row[]) => {
          if (table === 'workout_sessions') return upsertSession(rows as Row);
          for (const r of rows as Row[]) server.sets.set(r.id as string, r);
          return Promise.resolve(ok);
        },
        delete: () => deleteSets(),
      }),
    },
  };
});

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

vi.stubGlobal('localStorage', storage());
const outbox = await import('./outbox');
const { pushWorkoutToNexus } = await import('./nexusSync');

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on });
type Queued = { kind: string; payload: NexusWorkoutPayload; attempts: number };
const queue = (): Queued[] => JSON.parse(localStorage.getItem('limelog-outbox') ?? '[]');

const workout = (n: number, over: Partial<NexusWorkoutPayload> = {}): NexusWorkoutPayload => ({
  sessionId: 'sess-1', sessionType: 'strength', date: '2026-11-19',
  sets: Array.from({ length: n }, (_, i) => ({ exercise: 'Bench', weightKg: 60, reps: i + 1 })),
  ...over,
}) as NexusWorkoutPayload;

function deferred() {
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((_, r) => (reject = r));
  return { promise, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('localStorage', storage());
  localStorage.setItem('limelog.dataOwner', 'user-1');
  server.sessions.clear();
  server.sets.clear();
  server.gate = null;
  server.reads = 0;
  outbox.resetWorkoutStamps();
  online(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('an in-flight push cancelled by Finish (limelog#118)', () => {
  it('is not written back to the queue when it fails', async () => {
    const hang = deferred();
    server.gate = hang.promise;
    at('2026-11-19T18:00:00.000Z');
    outbox.enqueue('upsert_workout_session', workout(6)); // live push; hangs
    await vi.waitFor(() => expect(server.gate).toBeNull());

    // Finish: cancel the stored items, queue the final payload.
    at('2026-11-19T18:40:00.000Z');
    outbox.cancel('upsert_workout_session', (p) => p.sessionId === 'sess-1');
    outbox.enqueue('upsert_workout_session', workout(15));

    hang.reject(new Error('network'));
    // The failed pass ends; the final payload is the only item left, untried.
    await vi.waitFor(async () => expect((await outbox.drain()).sent).toBe(1));
    expect(queue()).toHaveLength(0);
    expect(server.sets.size).toBe(15);
  });

  it('a failed push that was not cancelled is still kept for retry', async () => {
    const hang = deferred();
    server.gate = hang.promise;
    outbox.enqueue('upsert_workout_session', workout(3));
    await vi.waitFor(() => expect(server.gate).toBeNull());
    hang.reject(new Error('network'));
    await vi.waitFor(() => expect(queue()[0]?.attempts).toBe(1));
    expect(queue()).toHaveLength(1);
  });
});

describe('a stale workout push the LWW guard rejects (limelog#118)', () => {
  it('leaves the newer save’s sets alone', async () => {
    await pushWorkoutToNexus(workout(15, { updatedAt: '2026-11-19T18:40:00.000Z' }), 'user-1');
    expect(server.sets.size).toBe(15);
    await pushWorkoutToNexus(workout(6, { updatedAt: '2026-11-19T18:00:00.000Z' }), 'user-1');
    expect(server.sets.size).toBe(15);
    expect(server.sessions.get('sess-1')?.updated_at).toBe('2026-11-19T18:40:00.000Z');
  });

  it('a rejection with an empty RETURNING (the real server) is settled by reading the stored stamp', async () => {
    await pushWorkoutToNexus(workout(15, { updatedAt: '2026-11-19T18:40:00.000Z' }), 'user-1');
    expect(server.reads).toBe(0);
    await pushWorkoutToNexus(workout(6, { updatedAt: '2026-11-19T18:00:00.000Z' }), 'user-1');
    expect(server.reads).toBe(1);
    expect(server.sets.size).toBe(15);
  });

  it('a no-op re-push with a newer stamp (also empty RETURNING) still counts as accepted', async () => {
    await pushWorkoutToNexus(workout(15, { updatedAt: '2026-11-19T18:00:00.000Z' }), 'user-1');
    const before = server.sessions.get('sess-1');
    // Same content, newer stamp: the server skips it and keeps the older stamp.
    server.sessions.set('sess-1', { ...before!, updated_at: '2026-11-19T18:00:00.000Z' });
    server.sets.delete([...server.sets.keys()][14]);
    await pushWorkoutToNexus(workout(15, { updatedAt: '2026-11-19T18:40:00.000Z' }), 'user-1');
    expect(server.reads).toBe(1);
    expect(server.sets.size).toBe(15);
  });

  it('a newer save still replaces the set list', async () => {
    await pushWorkoutToNexus(workout(15, { updatedAt: '2026-11-19T18:00:00.000Z' }), 'user-1');
    await pushWorkoutToNexus(workout(12, { updatedAt: '2026-11-19T18:40:00.000Z' }), 'user-1');
    expect(server.sets.size).toBe(12);
  });
});
