import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#94) — the screens hold while the local data is not yet the
// signed-in account's. nexusStore, accountOwner, accountWipe and dataReady
// are real; the auth client, Preferences, the outbox and the stores the clear
// empties are stand-ins. useDataReady() is the nexus store's selector over
// dataReadiness(), so each case reads it the way the hook does: from the
// store's state, re-read on every store update, sampled once per task as
// React renders it (updates made in one go, such as a take-up and the
// account set after it, render once).

type User = { id: string; email: string; user_metadata: Record<string, unknown> };
type Session = { user: User };
type Listener = (event: string, session: Session | null) => void;

const h = vi.hoisted(() => ({
  guest: false,
  stored: null as null | { user: User; expiresAt: number; expired: boolean },
  listener: null as Listener | null,
  /** No session in storage: getSession() answers "none" rather than hanging. */
  noSession: false,
  clearOk: undefined as boolean | undefined,
  signUpUser: null as User | null,
  prefs: new Map<string, string>(),
  /** While set, Preferences reads wait for it (a slow plugin). */
  prefsHold: null as null | Promise<void>,
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
      // A sign-up that needs its emailed code: no session yet.
      signUp: async () => ({ data: { user: h.signUpUser, session: null }, error: null }),
      // Offline (never answers), unless there is no session to look for.
      getSession: () => (h.noSession ? Promise.resolve({ data: { session: null }, error: null }) : new Promise(() => {})),
      onAuthStateChange: (cb: Listener) => {
        h.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));
vi.mock('@/lib/captcha', () => ({ withCaptcha: (fn: (token?: string) => unknown) => fn(undefined) }));
vi.mock('@/lib/oauth', () => ({ signInWithGoogle: vi.fn(), initOAuthDeepLinkListener: vi.fn() }));
vi.mock('@/lib/guestMode', () => ({ isGuestMode: () => h.guest, setGuestMode: vi.fn() }));
vi.mock('@/lib/suiteSso', () => ({ inheritFromNexus: () => new Promise(() => {}) }));
vi.mock('@/lib/originMarker', () => ({ scheduleOriginStamp: vi.fn() }));
vi.mock('@/lib/appOpens', () => ({ watchAppOpens: vi.fn(), recordAppOpen: vi.fn(async () => true), forgetLastAppOpen: vi.fn() }));
vi.mock('@/lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
vi.mock('@/lib/outbox', () => ({
  drain: vi.fn(async () => ({ sent: 0, remaining: 0 })),
  getStatus: () => ({ pending: 0, lastSuccessAt: null, lastError: null, lastErrorAt: null, oldestEnqueuedAt: null, stuck: 0 }),
  clear: vi.fn(() => h.clearOk),
  noteError: vi.fn(),
  installDrainTriggers: vi.fn(),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: { getState: () => ({ syncEntitlement: vi.fn(async () => {}) }) } }));
vi.mock('@/store/logStore', () => ({ useLogStore: { setState: vi.fn() } }));
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
const A: User = { id: 'user-a', email: 'a@example.com', user_metadata: {} };
const B: User = { id: 'user-b', email: 'b@example.com', user_metadata: {} };

/** A fresh store and the readiness as useDataReady() selects it, with every
 *  value it reported to a subscriber (what re-renders the app shell). */
async function freshApp() {
  vi.resetModules();
  const store = (await import('@/store/nexusStore')).useNexusStore;
  const { dataReadiness } = await import('./dataReady');
  const ready = () => dataReadiness(store.getState().userId);
  const seen: string[] = [];
  let queued = false;
  store.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const r = ready();
      if (seen[seen.length - 1] !== r) seen.push(r);
    });
  });
  const owner = await import('./accountOwner');
  return { store, ready, seen, owner, dataReadiness };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.guest = false;
  h.stored = null;
  h.listener = null;
  h.noSession = false;
  h.clearOk = undefined;
  h.signUpUser = null;
  h.prefs = new Map();
  h.prefsHold = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PRS = 'wt_exercise_prs';
const PROFILE = 'wt_profile';
const hang = () => new Promise<void>(() => {});

/** A launch on B's stored session while the mirror (which names A) does not
 *  answer: the launch stops waiting for it after 1.5 s. */
async function launchWhileRecordHangs(hold: Promise<void>) {
  h.prefs.set(OWNER_KEY, A.id); // localStorage lost it; the mirror has A
  h.prefsHold = hold;
  h.stored = { user: B, expiresAt: 0, expired: true };
  const app = await freshApp();
  const init = app.store.getState().init();
  await vi.advanceTimersByTimeAsync(1500);
  await init;
  return app;
}

/** A's session ended without a sign-out; B signs in and A's clear fails. */
async function waitingForClear() {
  localStorage.setItem(OWNER_KEY, A.id);
  h.guest = true;
  h.noSession = true;
  const app = await freshApp();
  await app.store.getState().init();
  h.clearOk = false;
  h.listener!('SIGNED_IN', { user: B });
  await flush();
  return app;
}

describe('useDataReady (LimeLog#94)', () => {
  it("is ready at once for the owner's own session, offline and unverified", async () => {
    localStorage.setItem(OWNER_KEY, A.id);
    h.stored = { user: A, expiresAt: 0, expired: true };
    const { store, ready, seen } = await freshApp();
    await store.getState().init();
    await flush();
    expect(store.getState()).toMatchObject({ userId: A.id, sessionUnverified: true });
    expect(ready()).toBe('ready');
    // 'held' only inside init, before the session is read (App.tsx is on
    // its launch splash until init resolves); never pending or waiting.
    expect(seen).toEqual(['held', 'ready']);
  });

  it("is ready for a guest's own data (no owner)", async () => {
    h.guest = true;
    h.noSession = true;
    const { store, ready } = await freshApp();
    await store.getState().init();
    expect(ready()).toBe('ready');
  });

  it('is ready at once for a first sign-in (no owner yet): the take-up runs before the account is set', async () => {
    h.guest = true;
    h.noSession = true;
    const { store, ready, seen } = await freshApp();
    await store.getState().init();
    await flush();
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
    expect(ready()).toBe('ready');
    expect(seen).toEqual(['ready']);
  });

  it("holds a guest on the sign-in screen while the data is still an account's", async () => {
    localStorage.setItem(OWNER_KEY, A.id); // A's session ended without a sign-out
    h.guest = true;
    h.noSession = true;
    const { store, ready } = await freshApp();
    await store.getState().init();
    expect(ready()).toBe('held');
    const gate = { userId: null, sessionUnverified: false, configured: true, readiness: ready() };
    const { showsSignIn } = await import('./dataReady');
    expect(showsSignIn({ ...gate, guestMode: true })).toBe(true);
  });

  it('keeps a sign-up waiting for its code on the sign-in screen (SF1)', async () => {
    localStorage.setItem(OWNER_KEY, A.id); // A's data on the device
    h.noSession = true;
    h.guest = true;
    const { store, ready } = await freshApp();
    await store.getState().init();
    h.signUpUser = B;
    const { needsConfirmation } = await store.getState().signUp(B.email, 'pw');
    expect(needsConfirmation).toBe(true);
    expect(store.getState()).toMatchObject({ userEmail: B.email, userId: null });
    const { showsSignIn } = await import('./dataReady');
    const gate = { userId: null, sessionUnverified: false, configured: true, readiness: ready() };
    expect(showsSignIn({ ...gate, guestMode: false })).toBe(true);
    // ...and with no owner recorded too: the code step is not left.
    expect(showsSignIn({ ...gate, guestMode: false, readiness: 'ready' })).toBe(true);
    // An offline launch on a stored session, or a guest, still opens the app.
    expect(showsSignIn({ ...gate, userId: A.id, readiness: 'ready', guestMode: false })).toBe(false);
    expect(showsSignIn({ ...gate, readiness: 'ready', guestMode: true })).toBe(false);
  });

  it('is pending while the owner record is read back, and ready once the take-up has run', async () => {
    let release!: () => void;
    const { store, ready, seen } = await launchWhileRecordHangs(new Promise((res) => { release = res; }));
    expect(store.getState().userId).toBe(B.id);
    expect(ready()).toBe('pending');
    release();
    await flush();
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id); // A's data cleared, B's now
    expect(ready()).toBe('ready');
    expect(seen).toEqual(['pending', 'ready']); // the store told the shell
  });

  it('is pending for a guest too while the record is read, then held when it names an account', async () => {
    h.prefs.set(OWNER_KEY, A.id);
    let release!: () => void;
    h.prefsHold = new Promise((res) => { release = res; });
    h.guest = true;
    h.noSession = true;
    const { store, ready, seen } = await freshApp();
    const init = store.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;
    expect(ready()).toBe('pending');
    release();
    await flush();
    expect(ready()).toBe('held');
    expect(seen[seen.length - 1]).toBe('held'); // the store told the shell
  });

  it('Retry now reads the record again after a read that does not answer', async () => {
    const { ready, owner } = await launchWhileRecordHangs(hang());
    expect(ready()).toBe('pending');
    h.prefsHold = null; // the plugin answers now
    await owner.rereadOwnerRecord();
    await flush();
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
    expect(ready()).toBe('ready');
  });

  it("a guest's Continue while the record is unknown keeps the data and opens the app", async () => {
    localStorage.setItem('wt_session_logs', JSON.stringify([{ id: 'g1' }]));
    h.prefs.set(OWNER_KEY, A.id);
    h.prefsHold = hang();
    h.guest = true;
    h.noSession = true;
    const { store, ready, seen, owner } = await freshApp();
    const init = store.getState().init();
    await vi.advanceTimersByTimeAsync(1500);
    await init;
    expect(ready()).toBe('pending');
    owner.proceedWithoutOwnerRecord();
    await flush();
    expect(ready()).toBe('ready');
    expect(seen[seen.length - 1]).toBe('ready'); // the store told the shell
    expect(localStorage.getItem('wt_session_logs')).not.toBeNull(); // nothing cleared
    expect(h.prefs.get(OWNER_KEY)).toBe(A.id); // read again next launch
  });

  it('Sign out while the record is unknown clears the device and sets nothing aside (SF2)', async () => {
    localStorage.setItem(PRS, JSON.stringify([{ id: 'a1' }]));
    localStorage.setItem(PROFILE, JSON.stringify({ name: 'Alex' }));
    const { store, ready } = await launchWhileRecordHangs(hang());
    expect(ready()).toBe('pending');
    await store.getState().signOut();
    expect(store.getState().userId).toBeNull();
    expect(localStorage.getItem('limelog.parked')).toBeNull(); // nothing under B (or anyone)
    expect(localStorage.getItem(PRS)).toBeNull();
    expect(localStorage.getItem(PROFILE)).toBeNull();
    expect(ready()).toBe('ready');
  });

  it('is waiting after a clear that failed, and ready after Retry now clears it', async () => {
    const { store, ready, seen } = await waitingForClear();
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
    expect(ready()).toBe('waiting');
    await store.getState().retryPending(); // fails again: still waiting
    expect(ready()).toBe('waiting');
    h.clearOk = true;
    await store.getState().retryPending();
    await flush();
    expect(ready()).toBe('ready');
    expect(seen).toEqual(['held', 'waiting', 'ready']);
  });

  it("Sign out whose clear fails again keeps A's record: held, not handed to the next account (SF3)", async () => {
    const { store, ready } = await waitingForClear();
    await store.getState().signOut(); // the clear fails again
    expect(store.getState().userId).toBeNull();
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
    expect(ready()).toBe('held'); // the sign-in screen, with its guest question
    // "Continue as guest" whose clear fails stays there too, and says why.
    await expect(store.getState().continueAsGuest(async () => true)).rejects.toThrow('could not be removed');
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
    h.clearOk = true;
    expect(await store.getState().continueAsGuest(async () => true)).toBe(true);
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
    expect(ready()).toBe('ready');
  });

  it('Sign out from the waiting screen whose clear works leaves no owner: ready', async () => {
    const { store, ready } = await waitingForClear();
    h.clearOk = true;
    await store.getState().signOut();
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
    expect(ready()).toBe('ready');
  });
});
