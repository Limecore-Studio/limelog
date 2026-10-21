import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient, makeUuids, type FakeRequest } from '../test/fakePostgrest';

// v1.16 (limecore#28) — the real recovery pull, against a PostgREST stand-in
// that truncates at 1000 rows without an error, the way the real one does.
// Recovery rebuilds a user's history after a reinstall, so a truncated pull
// quietly gave a heavy lifter back only part of it.

const USER = 'user-1';
type TestClient = ReturnType<typeof client>;
const holder = vi.hoisted(() => ({ client: null as TestClient | null }));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  get supabase() {
    return holder.client;
  },
}));

const { pullWorkoutsFromCloud } = await import('./nexusRecovery');

/** A client whose `auth.getUser()` resolves to USER, over the fake tables. */
function client(tables: Record<string, Record<string, unknown>[]>, opts: Parameters<typeof fakeClient>[1] = {}) {
  const c = fakeClient(tables, opts);
  return Object.assign(c, {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
  });
}

/**
 * `sessions` workouts of `setsPer` sets each. Set ids are random v4 uuids, as
 * every set written before 1.15.1 has, and each session's sets are inserted in
 * lift order with rising weights — so lift order is recoverable ONLY from
 * insertion order, never from the ids.
 */
function history(sessions: number, setsPer: number) {
  const sessionRows = makeUuids(sessions).map((id, i) => ({
    id,
    user_id: USER,
    session_type: 'strength',
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
  }));
  const setRows = sessionRows.flatMap((s) =>
    Array.from({ length: setsPer }, (_, k) => ({
      id: crypto.randomUUID(),
      user_id: USER,
      session_id: s.id,
      exercise: 'Squat',
      weight_kg: 60 + k * 10,
      reps: 5,
      rpe: null,
      created_at: '2026-01-01T10:00:00Z', // tied, as it is in production
    })),
  );
  return { sessionRows, setRows };
}

const weightsIn = (log: { sets: { weightKg: number | null }[] }) => log.sets.map((s) => s.weightKg);

beforeEach(() => {
  holder.client = null;
});

describe('pullWorkoutsFromCloud', () => {
  it('reproduces the old truncation: a bare select stops at 1000 rows', async () => {
    const h = history(1200, 3);
    const c = client({ workout_sets: h.setRows });
    const bare = await c.from('workout_sets').select('*').eq('user_id', USER);
    expect(bare.error).toBeNull();
    expect(bare.data).toHaveLength(1000);
  });

  it('recovers every session and every set past the cap', async () => {
    const h = history(1200, 3);
    holder.client = client({ workout_sessions: h.sessionRows, workout_sets: h.setRows });
    const logs = await pullWorkoutsFromCloud([]);
    expect(logs).toHaveLength(1200);
    expect(logs.every((l) => l.sets.length === 3)).toBe(true);
    expect(logs.reduce((n, l) => n + l.sets.length, 0)).toBe(3600);
  });

  it('restores each workout in lift order, not uuid order', async () => {
    // What keyset paging would have broken: ids are random, so ordering by id
    // shuffles a session's sets. Warm-up first, top set last.
    const h = history(50, 4);
    holder.client = client({ workout_sessions: h.sessionRows, workout_sets: h.setRows });
    const logs = await pullWorkoutsFromCloud([]);
    for (const log of logs) {
      expect(weightsIn(log)).toEqual([60, 70, 80, 90]);
      expect(log.sets.map((s) => s.setNumber)).toEqual([1, 2, 3, 4]);
    }
  });

  it('splits a batch that hits the cap, keeping every set and its order', async () => {
    // A small cap forces the split path: 40 sessions x 20 sets = 800 rows in
    // the first batch against a 50-row cap, halved until each fits.
    const h = history(40, 20);
    holder.client = client(
      { workout_sessions: h.sessionRows, workout_sets: h.setRows },
      { maxRows: 50 },
    );
    const logs = await pullWorkoutsFromCloud([]);
    expect(logs.reduce((n, l) => n + l.sets.length, 0)).toBe(800);
    const expected = Array.from({ length: 20 }, (_, k) => 60 + k * 10);
    expect(logs.every((l) => JSON.stringify(weightsIn(l)) === JSON.stringify(expected))).toBe(true);
    // Every set request that succeeded carried a whole number of sessions.
    const setReqs = holder.client!.requests.filter((r: FakeRequest) => r.table === 'workout_sets');
    expect(setReqs.every((r) => r.filters.some(([op]) => op === 'in'))).toBe(true);
  });

  it('falls back to id paging for a single session larger than the cap, losing no set', async () => {
    const h = history(1, 1500);
    holder.client = client({ workout_sessions: h.sessionRows, workout_sets: h.setRows });
    const [log] = await pullWorkoutsFromCloud([]);
    expect(log.sets).toHaveLength(1500);
  });

  it('pages the sessions pull by id', async () => {
    const h = history(1200, 1);
    holder.client = client({ workout_sessions: h.sessionRows, workout_sets: h.setRows });
    await pullWorkoutsFromCloud([]);
    const sessionReqs = holder.client!.requests.filter((r: FakeRequest) => r.table === 'workout_sessions');
    expect(sessionReqs.length).toBeGreaterThan(1);
    expect(sessionReqs.every((r) => r.order?.col === 'id')).toBe(true);
  });

  it('throws rather than restoring a partial history when a set request fails', async () => {
    const h = history(100, 3);
    holder.client = client(
      { workout_sessions: h.sessionRows, workout_sets: h.setRows },
      {
        failWhen: (req, n) =>
          req.table === 'workout_sets' && n > 2 ? { code: '57014', message: 'statement timeout' } : null,
      },
    );
    await expect(pullWorkoutsFromCloud([])).rejects.toMatchObject({ code: '57014' });
  });

  it('returns nothing for a user with no workouts', async () => {
    holder.client = client({ workout_sessions: [], workout_sets: [] });
    expect(await pullWorkoutsFromCloud([])).toEqual([]);
  });

  // v1.18.1 (LimeLog#85) — a pull started for one account, run after another
  // signed in, must not fetch the other account's workouts.
  it('refuses to pull when someone else is signed in than it was started for', async () => {
    const h = history(2, 1);
    holder.client = client({ workout_sessions: h.sessionRows, workout_sets: h.setRows });
    await expect(pullWorkoutsFromCloud([], 'user-2')).rejects.toThrow(/account changed/);
    expect(await pullWorkoutsFromCloud([], USER)).toHaveLength(2);
  });
});
