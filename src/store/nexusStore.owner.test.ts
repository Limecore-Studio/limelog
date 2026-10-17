import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.18.1 (LimeLog#88) — the local data follows its account through the auth
// events, and is cleared for a different account BEFORE that account's
// recovery pull or outbox drain can start. nexusStore, accountOwner,
// accountWipe and the recovery gate are real; the auth client, the outbox
// and the stores the clear empties are stand-ins that record what happened
// and in what order.

type User = { id: string; email: string; user_metadata: Record<string, unknown> };
type Session = { user: User };
type Listener = (event: string, session: Session | null) => void;
type GetSession = () => Promise<{ data: { session: Session | null }; error: { message: string } | null }>;

const h = vi.hoisted(() => ({
  guest: false,
  stored: null as null | { user: User; expiresAt: number; expired: boolean },
  getSession: (() => new Promise(() => {})) as GetSession,
  listener: null as Listener | null,
  log: [] as string[],
  clearOk: undefined as boolean | undefined,
  noted: [] as string[],
  logStoreSet: [] as unknown[],
}));

// v1.18.1 (LimeLog#92) — accountOwner mirrors the owner record into Preferences.
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@/lib/supabase', () => ({
  isNexusConfigured: true,
  readStoredSession: async () => h.stored,
  clearStoredSession: async () => {},
  storedRefreshToken: async () => 'rt',
  supabase: {
    auth: {
      signOut: () => Promise.resolve({ error: null }),
      getSession: () => h.getSession(),
      onAuthStateChange: (cb: Listener) => {
        h.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));
vi.mock('@/lib/captcha', () => ({ withCaptcha: vi.fn() }));
vi.mock('@/lib/oauth', () => ({ signInWithGoogle: vi.fn(), initOAuthDeepLinkListener: vi.fn() }));
vi.mock('@/lib/guestMode', () => ({ isGuestMode: () => h.guest, setGuestMode: vi.fn() }));
vi.mock('@/lib/suiteSso', () => ({ inheritFromNexus: () => new Promise(() => {}) }));
vi.mock('@/lib/originMarker', () => ({ scheduleOriginStamp: vi.fn() }));
vi.mock('@/lib/appOpens', () => ({ watchAppOpens: vi.fn(), recordAppOpen: vi.fn(async () => true), forgetLastAppOpen: vi.fn() }));
vi.mock('@/lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
vi.mock('@/lib/outbox', () => ({
  drain: vi.fn(async () => {
    h.log.push('drain');
    return { sent: 0, remaining: 0 };
  }),
  getStatus: () => ({ pending: 0, lastSuccessAt: null, lastError: null, lastErrorAt: null, oldestEnqueuedAt: null, stuck: 0 }),
  clear: vi.fn(() => {
    h.log.push('wipe');
    return h.clearOk;
  }),
  noteError: (m: string) => void h.noted.push(m),
  installDrainTriggers: vi.fn(),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: { getState: () => ({ syncEntitlement: vi.fn(async () => {}) }) } }));
vi.mock('@/store/logStore', () => ({ useLogStore: { setState: (s: unknown) => void h.logStoreSet.push(s) } }));
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

/** A fresh store with the recovery gate wired as App.tsx wires it, recording
 *  the account changes and the pulls into the same log as the clear and the
 *  drain. */
async function freshApp() {
  vi.resetModules();
  const store = (await import('./nexusStore')).useNexusStore;
  const { createRecoveryGate } = await import('@/lib/recoveryGate');
  const gate = createRecoveryGate({
    read: () => store.getState(),
    pull: async (userId) => {
      h.log.push(`pull:${userId}`);
      return [];
    },
    apply: () => 0,
    // As App.tsx wires it.
    ready: (userId) => localStorage.getItem(OWNER_KEY) === userId,
  });
  let lastUser: string | null = null;
  store.subscribe((s) => {
    if (s.userId !== lastUser) {
      lastUser = s.userId;
      h.log.push(`user:${s.userId}`);
    }
    gate.evaluate();
  });
  return store;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** A launch on A's stored session, confirmed: A owns the data. */
async function signedInAsA() {
  localStorage.setItem(OWNER_KEY, A.id);
  h.stored = { user: A, expiresAt: 0, expired: false };
  const store = await freshApp();
  await store.getState().init();
  h.listener!('INITIAL_SESSION', { user: A });
  await flush();
  h.log = [];
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.guest = false;
  h.stored = null;
  h.getSession = () => new Promise(() => {});
  h.listener = null;
  h.log = [];
  h.logStoreSet = [];
  h.clearOk = undefined;
  h.noted = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a session that ends without a sign-out (LimeLog#88)', () => {
  it('keeps the local data and its queue: nothing is cleared yet', async () => {
    const store = await signedInAsA();
    h.listener!('SIGNED_OUT', null); // refresh token refused: password changed elsewhere
    await flush();
    expect(h.log).not.toContain('wipe');
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
    expect(store.getState().userId).toBeNull();
  });

  it('the same account signing back in keeps it, and its queue is sent', async () => {
    await signedInAsA();
    h.listener!('SIGNED_OUT', null);
    h.listener!('SIGNED_IN', { user: A });
    await flush();
    expect(h.log).not.toContain('wipe');
    expect(h.log).toEqual(['user:null', 'user:user-a', 'drain', 'pull:user-a']);
  });

  it("another account signing in clears A's data before its pull and its drain", async () => {
    await signedInAsA();
    h.listener!('SIGNED_OUT', null);
    h.log = [];
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(h.log).toEqual(['wipe', 'user:user-b', 'drain', 'pull:user-b']);
    expect(h.logStoreSet).toContainEqual({ sessionLogs: [], jumpLogs: [], stallFlags: [] });
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
  });

  it('a switch with no SIGNED_OUT between (another account over the session) clears first too', async () => {
    await signedInAsA();
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(h.log.indexOf('wipe')).toBe(0);
    expect(h.log).toContain('pull:user-b');
  });

  it("a token refresh of the owner's session changes nothing", async () => {
    await signedInAsA();
    h.listener!('TOKEN_REFRESHED', { user: A });
    await flush();
    expect(h.log).toEqual([]);
  });
});

describe('offline cold start on the stored session (#67)', () => {
  it("the owner's unverified session opens with its data, and does not pull or send yet", async () => {
    localStorage.setItem(OWNER_KEY, A.id);
    h.stored = { user: A, expiresAt: 0, expired: true };
    const store = await freshApp();
    await store.getState().init(); // getSession() never answers: offline
    h.listener!('INITIAL_SESSION', null); // the refresh failed offline: not an answer
    await flush();
    expect(store.getState()).toMatchObject({ userId: A.id, sessionUnverified: true });
    expect(h.log).toEqual(['user:user-a']);
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
  });

  it("another account's stored session clears the previous data before it is shown", async () => {
    localStorage.setItem(OWNER_KEY, A.id);
    h.stored = { user: B, expiresAt: 0, expired: true };
    const store = await freshApp();
    await store.getState().init();
    expect(h.log).toEqual(['wipe', 'user:user-b']);
    expect(store.getState().sessionUnverified).toBe(true);
  });

  it('an answer overtaken by a newer sign-in does not clear the newer account', async () => {
    localStorage.setItem(OWNER_KEY, A.id);
    let answer!: (s: Session | null) => void;
    h.getSession = () => new Promise((res) => { answer = (s) => res({ data: { session: s }, error: null }); });
    const store = await freshApp();
    const done = store.getState().init();
    await flush();
    h.listener!('SIGNED_IN', { user: B }); // B signs in while the first answer is pending
    answer({ user: A }); // the stale answer names A
    await flush();
    await done;
    expect(h.log.filter((e) => e === 'wipe')).toHaveLength(1);
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
    expect(store.getState().userId).toBe(B.id);
  });
});

describe('guest data and explicit sign-out keep their behaviour', () => {
  it("a guest's data (no owner) is taken up by the first account to sign in", async () => {
    h.guest = true;
    h.getSession = async () => ({ data: { session: null }, error: null });
    const store = await freshApp();
    await store.getState().init();
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(h.log).not.toContain('wipe');
    expect(h.log).toContain('drain');
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
    expect(store.getState().userId).toBe(B.id);
  });

  it('sign-out clears the data and its owner; a guest carrying on is then taken up by the next account', async () => {
    const store = await signedInAsA();
    await store.getState().signOut();
    expect(h.log).toContain('wipe');
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
    h.log = [];
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(h.log).not.toContain('wipe');
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
  });

  it('a session reported while the sign-out runs does not take the data up again', async () => {
    const store = await signedInAsA();
    const out = store.getState().signOut();
    h.listener!('TOKEN_REFRESHED', { user: A }); // a refresh landing mid-sign-out
    await out;
    expect(localStorage.getItem(OWNER_KEY)).toBeNull();
  });
});

describe('a clear that fails (LimeLog#88)', () => {
  it('says sync is waiting, holds the pull unspent, and Retry now completes it', async () => {
    const store = await signedInAsA();
    h.listener!('SIGNED_OUT', null);
    h.clearOk = false;
    h.log = [];
    h.listener!('SIGNED_IN', { user: B });
    await flush();
    expect(localStorage.getItem(OWNER_KEY)).toBe(A.id);
    expect(h.noted).toEqual([expect.stringContaining('Sync is waiting')]);
    expect(h.log).not.toContain('pull:user-b');
    h.clearOk = true;
    await store.getState().retryPending();
    await flush();
    expect(localStorage.getItem(OWNER_KEY)).toBe(B.id);
    expect(h.log.filter((e) => e === 'wipe')).toHaveLength(2);
    expect(h.log).toContain('pull:user-b');
  });
});
