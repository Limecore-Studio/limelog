import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#88) — whose the local data is, and the outbox sending only
// under that account. The outbox and the push (pushFeedbackToNexus) run for
// real against a stand-in Supabase client whose current user can be switched;
// each insert records the session it ran under and the user_id it carried.

type Sent = { session: string | null; userId: unknown; feedback: unknown };
const h = vi.hoisted(() => ({
  user: 'user-a' as string | null,
  /** Users getUser() answers with, in turn, before falling back to `user`. */
  answers: [] as (string | null)[],
  sent: [] as Sent[],
  /** Replaces the insert's result, e.g. a push that hangs. */
  insert: null as null | (() => Promise<{ error: unknown }>),
  onPush: null as null | (() => void),
  /** v1.18.1 (LimeLog#92) — the Preferences mirror (SharedPreferences). */
  prefs: new Map<string, string>(),
  prefsFail: false,
  /** While set, Preferences reads wait for it (a slow plugin). */
  prefsHold: null as null | Promise<void>,
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (h.prefsHold) await h.prefsHold;
      if (h.prefsFail) throw new Error('plugin unavailable');
      return { value: h.prefs.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      if (h.prefsFail) throw new Error('plugin unavailable');
      h.prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => void h.prefs.delete(key),
  },
}));

vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  supabase: {
    auth: {
      getUser: async () => {
        const id = h.answers.length ? h.answers.shift()! : h.user;
        return { data: { user: id ? { id } : null }, error: null };
      },
    },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        h.sent.push({ session: h.user, userId: row.user_id, feedback: row.message });
        h.onPush?.();
        return h.insert ? h.insert() : Promise.resolve({ error: null });
      },
    }),
  },
}));

// Stored entries are own enumerable properties and the methods are not, as
// in a browser: the erase lists keys with Object.keys(localStorage).
// `refuse` makes setItem throw for a key, as a full store does.
function storage(refuse?: string): Storage {
  const store = {} as Record<string, string>;
  const methods = {
    getItem: (k: string) => (Object.keys(store).includes(k) ? store[k] : null),
    setItem: (k: string, v: string) => {
      if (k === refuse) throw new Error('QuotaExceededError');
      store[k] = String(v);
    },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(store, name, { value, enumerable: false });
  }
  Object.defineProperty(store, 'length', { get: () => Object.keys(store).length, enumerable: false });
  return store as unknown as Storage;
}

// The outbox reads storage on module load (legacy migration).
vi.stubGlobal('localStorage', storage());
const owner = await import('./accountOwner');
const outbox = await import('./outbox');
const { wipeAllLocalData } = await import('./dataRights');

/** Queue items without the drain enqueue() fires, as a queue left from earlier. */
function queued(...messages: string[]) {
  const items = messages.map((message, i) => ({
    id: `item-${i}`, createdAt: '2026-10-17T06:00:00Z', kind: 'submit_feedback', attempts: 0,
    payload: { id: `fb-${i}`, category: 'idea', rating: null, message, appVersion: '1', platform: 'web' },
  }));
  localStorage.setItem('limelog-outbox', JSON.stringify(items));
}

const wipe = vi.fn(() => outbox.clear());

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('navigator', { onLine: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.user = 'user-a';
  h.answers = [];
  h.sent = [];
  h.insert = null;
  h.onPush = null;
  h.prefs.clear();
  h.prefsFail = false;
  h.prefsHold = null;
  wipe.mockClear();
  owner.configureAccountOwner({ wipe });
  outbox.clear();
});

afterEach(() => {
  owner.configureAccountOwner(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('adoptLocalData', () => {
  it('first sign-in, or a guest\'s data: taken up as it is', () => {
    expect(owner.adoptLocalData('user-a')).toBe(true);
    expect(wipe).not.toHaveBeenCalled();
    expect(owner.readOwner()).toBe('user-a');
  });

  it('the same account again keeps its data', () => {
    owner.adoptLocalData('user-a');
    expect(owner.adoptLocalData('user-a')).toBe(true);
    expect(wipe).not.toHaveBeenCalled();
  });

  it("another account clears the previous account's data, then owns it", () => {
    owner.adoptLocalData('user-a');
    let ownerDuringWipe: string | null = null;
    wipe.mockImplementationOnce(() => { ownerDuringWipe = owner.readOwner(); return true; });
    expect(owner.adoptLocalData('user-b')).toBe(true);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(ownerDuringWipe).toBe('user-a'); // the record moves only after the clear
    expect(owner.readOwner()).toBe('user-b');
  });

  it('after the record is cleared (explicit sign-out) the next account takes the data up', () => {
    owner.adoptLocalData('user-a');
    owner.clearOwner();
    expect(owner.adoptLocalData('user-b')).toBe(true);
    expect(wipe).not.toHaveBeenCalled();
  });

  it('no id is not an owner', () => {
    expect(owner.adoptLocalData(null)).toBe(false);
    expect(owner.adoptLocalData(undefined)).toBe(false);
    expect(owner.readOwner()).toBeNull();
  });

  it('takes nothing up while a sign-out runs', () => {
    owner.configureAccountOwner({ wipe, paused: () => true });
    expect(owner.adoptLocalData('user-a')).toBe(false);
    expect(owner.readOwner()).toBeNull();
  });

  it("with no clear wired in, refuses another account's data rather than adopting it", () => {
    owner.adoptLocalData('user-a');
    owner.configureAccountOwner(null);
    expect(owner.adoptLocalData('user-b')).toBe(false);
    expect(owner.readOwner()).toBe('user-a');
  });

  it('a clear that fails part-way keeps the previous owner, and is tried again', () => {
    owner.adoptLocalData('user-a');
    wipe.mockImplementationOnce(() => false);
    expect(owner.adoptLocalData('user-b')).toBe(false);
    expect(owner.readOwner()).toBe('user-a');
    expect(owner.adoptLocalData('user-b')).toBe(true); // the clear works this time
    expect(wipe).toHaveBeenCalledTimes(2);
    expect(owner.readOwner()).toBe('user-b');
  });

  it('a record storage refuses (full) is kept in memory for the launch, so sync carries on', async () => {
    vi.stubGlobal('localStorage', storage(owner.OWNER_KEY));
    expect(owner.adoptLocalData('user-a')).toBe(true);
    expect(owner.readOwner()).toBe('user-a');
    expect(localStorage.getItem(owner.OWNER_KEY)).toBeNull();
    queued('a1');
    expect(await outbox.drain()).toEqual({ sent: 1, remaining: 0 });
    owner.clearOwner();
    expect(owner.readOwner()).toBeNull();
  });

  it('an erase removes the record with the other limelog. keys', () => {
    owner.adoptLocalData('user-a');
    wipeAllLocalData();
    expect(owner.readOwner()).toBeNull();
  });
});

describe('the outbox sends only under the account the queue belongs to', () => {
  it('same account returning: its queued changes are sent', async () => {
    owner.adoptLocalData('user-a');
    queued('a1', 'a2');
    expect(await outbox.drain()).toEqual({ sent: 2, remaining: 0 });
    expect(h.sent).toEqual([
      { session: 'user-a', userId: 'user-a', feedback: 'a1' },
      { session: 'user-a', userId: 'user-a', feedback: 'a2' },
    ]);
  });

  it("another account's session: the drain sends nothing and clears nothing; the auth path's take-up clears A's queue", async () => {
    owner.adoptLocalData('user-a');
    queued('a1', 'a2');
    h.user = 'user-b'; // A's session ended; B signed in
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 2 });
    expect(wipe).not.toHaveBeenCalled(); // the drain only checks
    expect(owner.adoptLocalData('user-b')).toBe(true); // nexusStore's listener
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 0 });
    expect(h.sent).toEqual([]);
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it("a stale getUser() reply for A after B took the data up: nothing cleared, nothing sent", async () => {
    owner.adoptLocalData('user-a');
    queued('a1');
    h.user = 'user-b';
    owner.adoptLocalData('user-b'); // B signs in: A's data cleared
    queued('b1'); // B logs offline
    h.answers = ['user-a']; // a drain's getUser() sent with A's token answers late
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 1 });
    expect(h.sent).toEqual([]);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(owner.readOwner()).toBe('user-b');
    expect(await outbox.drain()).toEqual({ sent: 1, remaining: 0 }); // B's own reply
    expect(h.sent).toEqual([{ session: 'user-b', userId: 'user-b', feedback: 'b1' }]);
  });

  it("with no clear wired in, sends nothing and keeps A's queue", async () => {
    owner.adoptLocalData('user-a');
    owner.configureAccountOwner(null);
    queued('a1');
    h.user = 'user-b';
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 1 });
    expect(h.sent).toEqual([]);
  });

  it('a guest queue (no owner) waits for the take-up, then goes with the first account to sign in, as before', async () => {
    queued('guest');
    h.user = 'user-b';
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 1 }); // not taken up yet
    expect(owner.adoptLocalData('user-b')).toBe(true);
    expect(await outbox.drain()).toEqual({ sent: 1, remaining: 0 });
    expect(h.sent).toEqual([{ session: 'user-b', userId: 'user-b', feedback: 'guest' }]);
    expect(wipe).not.toHaveBeenCalled();
  });

  it('stops part-way when the data changes hands during a push', async () => {
    owner.adoptLocalData('user-a');
    queued('a1', 'a2');
    h.onPush = () => {
      h.onPush = null;
      owner.clearOwner(); // an explicit sign-out while the first push was out
    };
    await outbox.drain();
    expect(h.sent.map((x) => x.feedback)).toEqual(['a1']);
  });

  it('no session: nothing is sent and nothing is claimed', async () => {
    owner.adoptLocalData('user-a');
    queued('a1');
    h.user = null; // the involuntary SIGNED_OUT
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 1 });
    expect(owner.readOwner()).toBe('user-a');
    expect(wipe).not.toHaveBeenCalled();
  });

  it("a failed clear sends nothing for the new account and keeps A's queue", async () => {
    owner.adoptLocalData('user-a');
    queued('a1');
    wipe.mockImplementationOnce(() => false);
    h.user = 'user-b';
    expect(owner.adoptLocalData('user-b')).toBe(false);
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 1 });
    expect(h.sent).toEqual([]);
    expect(owner.readOwner()).toBe('user-a');
  });

  it("a push that fails after the queue changed hands is not put back, so B never sends it", async () => {
    owner.adoptLocalData('user-a');
    queued('a1');
    let fail!: () => void;
    h.insert = () => new Promise((res) => { fail = () => res({ error: { message: 'network' } }); });
    const first = outbox.drain(); // A's push hangs
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.user = 'user-b'; // A's session ends, B signs in: the listener takes the data up
    expect(owner.adoptLocalData('user-b')).toBe(true);
    fail();
    await first;
    expect(outbox.getStatus().pending).toBe(0);
    expect(outbox.getStatus().lastError).toBeNull();
    h.insert = null;
    await outbox.drain();
    expect(h.sent).toHaveLength(1); // only A's own attempt, under A
    expect(h.sent[0]).toMatchObject({ session: 'user-a', userId: 'user-a' });
  });

  it('a push that finds another account signed in refuses, without counting an attempt', async () => {
    owner.adoptLocalData('user-a');
    queued('a1');
    h.answers = ['user-a', 'user-b']; // the drain sees A; the push, a moment later, B
    expect(await outbox.drain()).toEqual({ sent: 0, remaining: 1 });
    expect(h.sent).toEqual([]);
    const [item] = JSON.parse(localStorage.getItem('limelog-outbox')!);
    expect(item.attempts).toBe(0);
  });
});

// v1.18.1 (LimeLog#92) — the record mirrored into Preferences, so a full
// localStorage cannot lose it between launches.
describe('the owner record mirrored into Preferences', () => {
  /** A new launch: the module state (the in-memory owner) starts over. */
  async function relaunch() {
    vi.resetModules();
    const fresh = await import('./accountOwner');
    fresh.configureAccountOwner({ wipe });
    return fresh;
  }

  it('every write and clear reaches Preferences, in order', async () => {
    owner.adoptLocalData('user-a', 'a@example.com');
    await owner.ownerMirrorSettled();
    expect(h.prefs.get(owner.OWNER_KEY)).toBe('user-a');
    expect(h.prefs.get(owner.OWNER_EMAIL_KEY)).toBe('a@example.com');
    owner.clearOwner();
    await owner.ownerMirrorSettled();
    expect(h.prefs.size).toBe(0);
  });

  it('localStorage full: the next launch finds the owner in Preferences, so another account clears it', async () => {
    vi.stubGlobal('localStorage', storage(owner.OWNER_KEY));
    owner.adoptLocalData('user-a');
    await owner.ownerMirrorSettled();
    expect(localStorage.getItem(owner.OWNER_KEY)).toBeNull(); // the WebView store refused it
    expect(h.prefs.get(owner.OWNER_KEY)).toBe('user-a');

    const next = await relaunch();
    expect(next.readOwner()).toBeNull(); // before the launch reads the mirror
    await next.loadOwnerRecord();
    expect(next.readOwner()).toBe('user-a'); // still full: held in memory
    expect(next.adoptLocalData('user-b')).toBe(true);
    expect(wipe).toHaveBeenCalledWith('user-a');
  });

  it('localStorage emptied (no record at launch): the mirrored record is used and written back', async () => {
    h.prefs.set(owner.OWNER_KEY, 'user-a');
    h.prefs.set(owner.OWNER_EMAIL_KEY, 'a@example.com');
    const next = await relaunch();
    await next.loadOwnerRecord();
    expect(localStorage.getItem(next.OWNER_KEY)).toBe('user-a');
    expect(next.readOwnerEmail()).toBe('a@example.com');
    expect(next.adoptLocalData('user-a')).toBe(true);
    expect(wipe).not.toHaveBeenCalled();
  });

  it('a record in localStorage wins over the mirror, which is brought in line', async () => {
    localStorage.setItem(owner.OWNER_KEY, 'user-b');
    h.prefs.set(owner.OWNER_KEY, 'user-a');
    const next = await relaunch();
    await next.loadOwnerRecord();
    await next.ownerMirrorSettled();
    expect(next.readOwner()).toBe('user-b');
    expect(h.prefs.get(next.OWNER_KEY)).toBe('user-b');
  });

  it('no take-up while the mirror is being read; then the mirrored owner decides', async () => {
    h.prefs.set(owner.OWNER_KEY, 'user-a');
    const next = await relaunch();
    const loading = next.loadOwnerRecord();
    expect(next.adoptLocalData('user-b')).toBe(false); // B's session, before the read lands
    await loading;
    expect(next.readOwner()).toBe('user-a');
    expect(next.adoptLocalData('user-b')).toBe(true);
    expect(wipe).toHaveBeenCalledWith('user-a');
  });

  it('a sign-out while the mirror is being read wins over its answer', async () => {
    h.prefs.set(owner.OWNER_KEY, 'user-a');
    const next = await relaunch();
    const loading = next.loadOwnerRecord();
    next.clearOwner();
    await loading;
    expect(next.readOwner()).toBeNull();
  });

  it('a read that outlasts the wait: take-ups stay refused until it lands, then are tried again', async () => {
    let release!: () => void;
    h.prefsHold = new Promise((res) => { release = res; });
    h.prefs.set(owner.OWNER_KEY, 'user-a');
    const next = await relaunch();
    const settled = vi.fn();
    next.configureAccountOwner({ wipe, recordSettled: settled });
    await next.loadOwnerRecord(5); // the launch stops waiting
    expect(next.adoptLocalData('user-b')).toBe(false); // no claim, so no drain or pull for B
    expect(next.readOwner()).toBeNull();
    release();
    await next.ownerRecordKnown();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(next.readOwner()).toBe('user-a');
    expect(next.adoptLocalData('user-b')).toBe(true);
    expect(wipe).toHaveBeenCalledWith('user-a');
  });

  it('a record in localStorage does not wait for the mirror', async () => {
    h.prefsHold = new Promise(() => {}); // never answers
    localStorage.setItem(owner.OWNER_KEY, 'user-a');
    const next = await relaunch();
    await next.loadOwnerRecord(5);
    expect(next.adoptLocalData('user-a')).toBe(true);
  });

  it('no Preferences (the plugin fails): localStorage alone, as before', async () => {
    h.prefsFail = true;
    const next = await relaunch();
    await next.loadOwnerRecord();
    expect(next.adoptLocalData('user-a')).toBe(true);
    await next.ownerMirrorSettled();
    expect(next.readOwner()).toBe('user-a');
  });

  it('the email follows the same account, and goes with the record', () => {
    owner.adoptLocalData('user-a', 'a@example.com');
    owner.adoptLocalData('user-a', 'new@example.com'); // address changed
    expect(owner.readOwnerEmail()).toBe('new@example.com');
    owner.adoptLocalData('user-b'); // another account, address unknown
    expect(owner.readOwnerEmail()).toBeNull();
    owner.adoptLocalData('user-b', 'b@example.com');
    owner.clearOwner();
    expect(owner.readOwnerEmail()).toBeNull();
  });
});

describe('putting back what was set aside (LimeLog#90)', () => {
  it('runs on a change of owner, and for the same owner too (a slot can still be there)', () => {
    const restore = vi.fn();
    owner.configureAccountOwner({ wipe, restore });
    owner.adoptLocalData('user-a');
    owner.adoptLocalData('user-a');
    expect(restore).toHaveBeenNthCalledWith(1, 'user-a');
    expect(restore).toHaveBeenNthCalledWith(2, 'user-a');
  });

  it('not when the take-up is refused', () => {
    const restore = vi.fn();
    owner.configureAccountOwner({ wipe, restore, paused: () => true });
    owner.adoptLocalData('user-a');
    expect(restore).not.toHaveBeenCalled();
  });
});
