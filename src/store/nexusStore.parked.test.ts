import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#90/#91/#92) — what the account clear does with the
// personal records and the profile (set aside per account, put back when the
// account returns), "Continue as guest" after a session that ended without a
// sign-out, and the owner record's Preferences mirror at launch. nexusStore,
// accountOwner, accountWipe and parkedData are real; the auth client, the
// outbox and the in-memory stores are stand-ins that record their state.

type User = { id: string; email: string; user_metadata: Record<string, unknown> };
type Session = { user: User };
type Listener = (event: string, session: Session | null) => void;

const h = vi.hoisted(() => ({
  stored: null as null | { user: User; expiresAt: number; expired: boolean },
  listener: null as Listener | null,
  pending: 0,
  setGuestMode: [] as boolean[],
  log: { exercisePRs: [] as unknown[], lastCelebratedPRs: null as unknown, sessionLogs: [] as unknown[] },
  user: { profile: null as unknown },
  prefs: new Map<string, string>(),
  /** While set, Preferences reads wait for it (a slow plugin). */
  prefsHold: null as null | Promise<void>,
  drains: 0,
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (h.prefsHold) await h.prefsHold;
      return { value: h.prefs.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => void h.prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void h.prefs.delete(key),
  },
}));
vi.mock('@/lib/supabase', () => ({
  isNexusConfigured: true,
  readStoredSession: async () => h.stored,
  clearStoredSession: async () => {},
  storedRefreshToken: async () => 'rt',
  supabase: {
    auth: {
      signOut: () => Promise.resolve({ error: null }),
      getSession: () => new Promise(() => {}),
      onAuthStateChange: (cb: Listener) => {
        h.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));
vi.mock('@/lib/captcha', () => ({ withCaptcha: vi.fn() }));
vi.mock('@/lib/oauth', () => ({ signInWithGoogle: vi.fn(), initOAuthDeepLinkListener: vi.fn() }));
vi.mock('@/lib/guestMode', () => ({
  isGuestMode: () => false,
  setGuestMode: (v: boolean) => void h.setGuestMode.push(v),
}));
vi.mock('@/lib/suiteSso', () => ({ inheritFromNexus: () => new Promise(() => {}) }));
vi.mock('@/lib/originMarker', () => ({ scheduleOriginStamp: vi.fn() }));
vi.mock('@/lib/appOpens', () => ({ watchAppOpens: vi.fn(), recordAppOpen: vi.fn(async () => true), forgetLastAppOpen: vi.fn() }));
vi.mock('@/lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
vi.mock('@/lib/outbox', () => ({
  drain: vi.fn(async () => {
    h.drains++;
    return { sent: 0, remaining: 0 };
  }),
  getStatus: () => ({ pending: h.pending, lastSuccessAt: null, lastError: null, lastErrorAt: null, oldestEnqueuedAt: null, stuck: 0 }),
  clear: vi.fn(() => {
    h.pending = 0;
  }),
  noteError: vi.fn(),
  installDrainTriggers: vi.fn(),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: { getState: () => ({ syncEntitlement: vi.fn(async () => {}) }) } }));
vi.mock('@/store/logStore', () => ({ useLogStore: { setState: (s: object) => void Object.assign(h.log, s), getState: () => h.log } }));
vi.mock('@/store/userStore', () => ({
  useUserStore: { setState: (s: object) => void Object.assign(h.user, s) },
  defaultProfile: () => ({ id: 'default', name: 'Athlete', unitPreference: 'kg', activeRestrictions: [] }),
}));
vi.mock('@/store/bodyMetricsStore', () => ({ useBodyMetricsStore: { setState: vi.fn() } }));
vi.mock('@/types/bodyMetrics', () => ({ DEFAULT_PREFS: {} }));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const OWNER_KEY = 'limelog.dataOwner';
const PRS = 'wt_exercise_prs';
const PROFILE = 'wt_profile';
const LOGS = 'wt_session_logs';
const A: User = { id: 'user-a', email: 'a@example.com', user_metadata: {} };
const B: User = { id: 'user-b', email: 'b@example.com', user_metadata: {} };

const pr = (id: string, exerciseId = 'squat', weightKg = 100) => ({
  id, exerciseId, exerciseName: 'Squat', weightKg, reps: 1, oneRepMaxKg: weightKg, sessionId: `s-${id}`, date: '2026-10-01', createdAt: '2026-10-01T10:00:00Z',
});
const restriction = (id: string, label: string) => ({
  id, label, restrictedPatterns: [], restrictedExerciseIds: [], severity: 'avoid', active: true, createdAt: '2026-10-01T10:00:00Z',
});
const profile = (name: string, restrictions: unknown[] = []) => ({
  id: `p-${name}`, name, unitPreference: 'lb', aiEnabled: true, activeRestrictions: restrictions,
  deloadThresholds: { stallCountTrigger: 2, avgFatigueTrigger: 7.5, fatigueLookbackSessions: 5 }, createdAt: '2026-10-01T10:00:00Z',
});
const json = (k: string) => JSON.parse(localStorage.getItem(k) ?? 'null');
const set = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));
const flush = () => vi.advanceTimersByTimeAsync(0);

/** A's data on the device: a workout, two records, a profile with an injury restriction. */
function aData() {
  set(LOGS, [{ id: 'w1' }]);
  set(PRS, [pr('a1'), pr('a2', 'bench', 80)]);
  set(PROFILE, profile('Alex', [restriction('r-knee', 'Knee')]));
}

async function freshStore() {
  vi.resetModules();
  return (await import('./nexusStore')).useNexusStore;
}

/** A launch on A's stored session: A owns the data. */
async function signedInAsA() {
  localStorage.setItem(OWNER_KEY, A.id);
  aData();
  h.stored = { user: A, expiresAt: 0, expired: false };
  const store = await freshStore();
  await store.getState().init();
  h.listener!('INITIAL_SESSION', { user: A });
  await flush();
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.stored = null;
  h.listener = null;
  h.pending = 0;
  h.setGuestMode = [];
  h.log = { exercisePRs: [pr('a1')], lastCelebratedPRs: [pr('a1')], sessionLogs: [] };
  h.user = { profile: profile('Alex') };
  h.prefs.clear();
  h.prefsHold = null;
  h.drains = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('records and profile set aside per account (LimeLog#90)', () => {
  it('sign-out sets them aside for A and the device starts clean', async () => {
    const store = await signedInAsA();
    await store.getState().signOut();
    expect(localStorage.getItem(PRS)).toBeNull();
    expect(localStorage.getItem(PROFILE)).toBeNull();
    expect(h.log).toMatchObject({ exercisePRs: [], lastCelebratedPRs: null });
    expect(h.user.profile).toMatchObject({ id: 'default', activeRestrictions: [] });
    const slot = json('limelog.parked')[A.id];
    expect(slot.prs.map((p: { id: string }) => p.id)).toEqual(['a1', 'a2']);
    expect(slot.profile.name).toBe('Alex');
  });

  it('A signing back in gets them back, into storage and the stores', async () => {
    const store = await signedInAsA();
    await store.getState().signOut();
    h.listener!('SIGNED_IN', { user: A });
    await flush();
    expect(json(PRS).map((p: { id: string }) => p.id)).toEqual(['a1', 'a2']);
    expect(json(PROFILE).activeRestrictions[0].label).toBe('Knee');
    expect((h.log.exercisePRs as unknown[]).length).toBe(2);
    expect(h.user.profile).toMatchObject({ name: 'Alex' });
    expect(json('limelog.parked')).toBeNull(); // the slot is spent
  });

  it('another account signing in after the sign-out does not get them', async () => {
    const store = await signedInAsA();
    await store.getState().signOut();
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(localStorage.getItem(PRS)).toBeNull();
    expect(localStorage.getItem(PROFILE)).toBeNull();
    expect(json('limelog.parked')[A.id]).toBeDefined();
  });

  it('an account switch (A over B, no sign-out) sets A\'s aside; B, then A again, each get their own', async () => {
    await signedInAsA();
    h.listener!('SIGNED_OUT', null); // A's session ends without a sign-out
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(localStorage.getItem(PRS)).toBeNull();
    expect(json('limelog.parked')[A.id].profile.name).toBe('Alex');
    set(PRS, [pr('b1')]); // B trains
    h.listener!('SIGNED_IN', { user: A });
    await flush();
    expect(json(PRS).map((p: { id: string }) => p.id)).toEqual(['a1', 'a2']);
    expect(json('limelog.parked')[B.id].prs.map((p: { id: string }) => p.id)).toEqual(['b1']);
    expect(json('limelog.parked')[A.id]).toBeUndefined();
  });

  it("a guest's data taken up by A: records joined, A's profile back with the guest's restriction kept", async () => {
    const store = await signedInAsA();
    await store.getState().signOut();
    set(PRS, [pr('g1', 'deadlift', 140)]); // a guest trains meanwhile
    set(PROFILE, profile('Athlete', [restriction('r-wrist', 'Wrist')]));
    h.listener!('SIGNED_IN', { user: A });
    await flush();
    expect(json(PRS).map((p: { id: string }) => p.id)).toEqual(['g1', 'a1', 'a2']);
    const restored = json(PROFILE);
    expect(restored.name).toBe('Alex');
    expect(restored.activeRestrictions.map((r: { label: string }) => r.label)).toEqual(['Knee', 'Wrist']);
  });

  it('the discard tombstones stay', async () => {
    const store = await signedInAsA();
    set('wt_session_tombstones', ['w0']);
    await store.getState().signOut();
    expect(json('wt_session_tombstones')).toEqual(['w0']);
  });
});

describe('"Continue as guest" with an account\'s data on the device (LimeLog#91)', () => {
  async function aEndedWithoutSignOut() {
    const store = await signedInAsA();
    h.pending = 3;
    h.listener!('SIGNED_OUT', null);
    await flush();
    return store;
  }

  it("asks first, naming A and the unsent changes; Cancel keeps A's data and owner", async () => {
    const store = await aEndedWithoutSignOut();
    const ask = vi.fn(async () => false);
    expect(await store.getState().continueAsGuest(ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith({ email: A.email, unsynced: 3 });
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
    expect(json(LOGS)).toEqual([{ id: 'w1' }]);
    expect(json(PRS)).toHaveLength(2);
    expect(h.setGuestMode).toEqual([]);
  });

  it('Continue clears it as a sign-out does, sets the records and profile aside for A, and leaves no owner', async () => {
    const store = await aEndedWithoutSignOut();
    expect(await store.getState().continueAsGuest(async () => true)).toBe(true);
    expect(localStorage.getItem(LOGS)).toBeNull();
    expect(localStorage.getItem(PRS)).toBeNull();
    expect(localStorage.getItem(PROFILE)).toBeNull();
    expect(json('limelog.parked')[A.id].profile.name).toBe('Alex');
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
    expect(localStorage.getItem('limelog.dataOwnerEmail')).toBeNull();
    await flush();
    expect(h.prefs.get(OWNER_KEY)).toBeUndefined();
    expect(store.getState().pendingCount).toBe(0);
    expect(h.setGuestMode).toEqual([true]);
  });

  it('no owner (a fresh install, or after a sign-out): straight into guest mode', async () => {
    const store = await freshStore();
    const ask = vi.fn(async () => true);
    expect(await store.getState().continueAsGuest(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(h.setGuestMode).toEqual([true]);
  });
});

describe('the owner record at launch (LimeLog#92)', () => {
  it('no record in localStorage but one in Preferences: a different stored session clears first', async () => {
    aData();
    h.prefs.set(OWNER_KEY, A.id); // localStorage lost it (full, then emptied)
    h.stored = { user: B, expiresAt: 0, expired: true };
    const store = await freshStore();
    await store.getState().init();
    expect(localStorage.getItem(LOGS)).toBeNull(); // A's data, not B's to take up
    expect(json('limelog.parked')[A.id]).toBeDefined();
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
  });

  it('the same account on Preferences alone keeps its data', async () => {
    aData();
    h.prefs.set(OWNER_KEY, A.id);
    h.stored = { user: A, expiresAt: 0, expired: true };
    const store = await freshStore();
    await store.getState().init();
    expect(json(LOGS)).toEqual([{ id: 'w1' }]);
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
  });

  it('a slow mirror read: nothing is taken up meanwhile, then the mirrored owner decides', async () => {
    aData();
    h.prefs.set(OWNER_KEY, A.id);
    let release!: () => void;
    h.prefsHold = new Promise((res) => { release = res; });
    h.stored = { user: B, expiresAt: 0, expired: true };
    const store = await freshStore();
    const init = store.getState().init();
    await vi.advanceTimersByTimeAsync(1500); // the launch stops waiting
    await init;
    expect(store.getState().userId).toBe(B.id); // the app opens on B
    expect(localStorage.getItem(OWNER_KEY)).toBeNull(); // but B has not taken A's data up
    expect(json(LOGS)).toEqual([{ id: 'w1' }]);
    const drainsBefore = h.drains;
    release();
    await flush();
    expect(localStorage.getItem(LOGS)).toBeNull(); // A's, cleared before B's
    expect(json('limelog.parked')[A.id]).toBeDefined();
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
    expect(h.drains).toBe(drainsBefore + 1); // B's queue goes now
  });

  it("A's slot is put back even when A is already the owner (the sign-out's mirror clear did not land)", async () => {
    set('limelog.parked', { [A.id]: { prs: [pr('a1')], profile: profile('Alex'), parkedAt: '2026-10-16T08:00:00Z' } });
    h.prefs.set(OWNER_KEY, A.id); // localStorage was cleared by the sign-out; the mirror was not
    h.stored = { user: A, expiresAt: 0, expired: false };
    const store = await freshStore();
    await store.getState().init();
    expect(json(PRS).map((p: { id: string }) => p.id)).toEqual(['a1']);
    expect(json(PROFILE).name).toBe('Alex');
    expect(json('limelog.parked')).toBeNull();
  });

  it('sign-out clears the mirror too', async () => {
    const store = await signedInAsA();
    await flush();
    expect(h.prefs.get(OWNER_KEY)).toBe(A.id);
    await store.getState().signOut();
    await flush();
    expect(h.prefs.has(OWNER_KEY)).toBe(false);
  });
});
