import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NexusWorkoutPayload } from './nexusSync';

// v1.16 (limecore#27, registry P6) — a workout is stamped when it is SAVED,
// through the real outbox and the real pushWorkoutToNexus. Only the Supabase
// client is a stand-in; it records the session row that would be sent.

type Row = Record<string, unknown>;
const sent = vi.hoisted(() => ({ sessions: [] as Row[] }));
// v1.18.1 (LimeLog#92) — accountOwner mirrors the owner record into Preferences.
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('./supabase', () => {
  const ok = { error: null };
  // Just enough of the builder for pushWorkoutToNexus: session upsert, set
  // upsert, and the `delete().eq().not()` cleanup of stale set rows.
  const chain = { eq: () => chain, not: () => chain, then: (r: (v: unknown) => unknown) => Promise.resolve(ok).then(r) };
  return {
    isNexusConfigured: true,
    supabase: {
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
      from: (table: string) => ({
        upsert: (row: Row) => {
          if (table === 'workout_sessions') sent.sessions.push(row);
          return Promise.resolve(ok);
        },
        delete: () => chain,
      }),
    },
  };
});

// The outbox migrates a legacy queue key on module load, so storage must
// exist before it is imported.
vi.stubGlobal('localStorage', storage());
const outbox = await import('./outbox');

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

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on });

const workout = (over: Partial<NexusWorkoutPayload> = {}): NexusWorkoutPayload =>
  ({ sessionId: 'sess-1', sessionType: 'strength', date: '2026-09-25', sets: [], ...over }) as NexusWorkoutPayload;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('localStorage', storage());
  // v1.18.1 (LimeLog#88) — the outbox sends only for the recorded owner.
  localStorage.setItem('limelog.dataOwner', 'user-1');
  sent.sessions = [];
  outbox.resetWorkoutStamps();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('workout sessions are stamped when saved', () => {
  it('a workout saved offline at 10:00 and pushed at 12:00 is sent stamped 10:00', async () => {
    online(false);
    at('2026-09-25T10:00:00.000Z');
    outbox.enqueue('upsert_workout_session', workout());
    at('2026-09-25T12:00:00.000Z');
    online(true);
    await outbox.drain();
    expect(sent.sessions.map((r) => r.updated_at)).toEqual(['2026-09-25T10:00:00.000Z']);
  });

  it('a later save of the same session is stamped later, even if the clock stepped back', async () => {
    online(false);
    at('2026-09-25T10:00:00.000Z');
    outbox.enqueue('upsert_workout_session', workout({ notes: 'first' }));
    at('2026-09-25T09:59:00.000Z'); // NTP stepped the clock back
    outbox.enqueue('upsert_workout_session', workout({ notes: 'second' }));
    online(true);
    await outbox.drain();
    const [a, b] = sent.sessions.map((r) => new Date(r.updated_at as string).getTime());
    expect(b).toBeGreaterThan(a);
  });

  it('an item queued by an older build, with no stamp, pushes with the send time as before', async () => {
    localStorage.setItem('limelog-outbox', JSON.stringify([
      { id: 'old', createdAt: '2026-09-20T08:00:00.000Z', kind: 'upsert_workout_session', payload: workout(), attempts: 0 },
    ]));
    online(true);
    at('2026-09-25T12:00:00.000Z');
    await outbox.drain();
    expect(sent.sessions.map((r) => r.updated_at)).toEqual(['2026-09-25T12:00:00.000Z']);
  });
});
