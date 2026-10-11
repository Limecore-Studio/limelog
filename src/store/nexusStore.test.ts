import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.19 (LL#64, LL#65) — the cold-start path of nexusStore.init() against a
// stand-in auth client whose getSession() can be held open, which is what an
// expired access token does offline: auth-js retries the refresh for ~25 s or
// longer before answering. Everything init() calls besides auth is a stub.

type Session = { user: { id: string; email: string; user_metadata: Record<string, unknown> } };
type Listener = (event: string, session: Session | null) => void;
type GetSession = () => Promise<{ data: { session: Session | null }; error: { message: string } | null }>;

const h = vi.hoisted(() => ({
  native: true,
  guest: false,
  stored: null as null | { user: Session['user']; expiresAt: number; expired: boolean },
  getSession: (() => new Promise(() => {})) as GetSession,
  inherit: () => new Promise<{ ok: boolean; reason?: string }>(() => {}),
  listener: null as Listener | null,
  calls: [] as string[],
  syncEntitlement: vi.fn(async () => {}),
  drain: vi.fn(async () => ({ sent: 0, remaining: 0 })),
  setGuestMode: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('@/lib/supabase', () => ({
  isNexusConfigured: true,
  readStoredSession: async () => h.stored,
  supabase: {
    auth: {
      getSession: () => {
        h.calls.push('getSession');
        return h.getSession();
      },
      onAuthStateChange: (cb: Listener) => {
        h.calls.push('onAuthStateChange');
        h.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  },
}));
vi.mock('@/lib/captcha', () => ({ withCaptcha: vi.fn() }));
vi.mock('@/lib/oauth', () => ({ signInWithGoogle: vi.fn(), initOAuthDeepLinkListener: vi.fn() }));
vi.mock('@/lib/guestMode', () => ({ isGuestMode: () => h.guest, setGuestMode: h.setGuestMode }));
vi.mock('@/lib/suiteSso', () => ({ inheritFromNexus: () => h.inherit() }));
vi.mock('@/lib/originMarker', () => ({ scheduleOriginStamp: vi.fn() }));
vi.mock('@/lib/appOpens', () => ({ watchAppOpens: vi.fn() }));
vi.mock('@/lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
vi.mock('@/lib/outbox', () => ({
  drain: h.drain,
  getStatus: () => ({ pending: 0, lastSuccessAt: null, lastError: null, lastErrorAt: null, oldestEnqueuedAt: null, stuck: 0 }),
  clear: vi.fn(),
  installDrainTriggers: vi.fn(),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: { getState: () => ({ syncEntitlement: h.syncEntitlement }) } }));
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

const USER = { id: 'user-1', email: 'lifter@example.com', user_metadata: { full_name: 'Lee Lifter' } };
const SESSION: Session = { user: USER };

async function freshStore() {
  vi.resetModules();
  return (await import('./nexusStore')).useNexusStore;
}

/** Let detached promise chains (settle(), the drain) run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.native = true;
  h.guest = false;
  h.stored = null;
  h.getSession = () => new Promise(() => {}); // an offline refresh that has not given up yet
  h.inherit = () => new Promise(() => {});
  h.listener = null;
  h.calls = [];
  h.syncEntitlement.mockClear();
  h.drain.mockClear();
  h.setGuestMode.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('init() with a session in storage (LL#64)', () => {
  beforeEach(() => {
    h.stored = { user: USER, expiresAt: 0, expired: true };
  });

  it('resolves from storage without waiting on getSession()', async () => {
    const store = await freshStore();
    await store.getState().init(); // getSession() never settles; this must not hang
    expect(store.getState()).toMatchObject({
      userEmail: USER.email,
      userName: 'Lee Lifter',
      sessionUnverified: true,
      loading: false,
    });
  });

  it('registers the auth listener before it asks for the session (LL#65)', async () => {
    const store = await freshStore();
    await store.getState().init();
    expect(h.calls).toEqual(['onAuthStateChange', 'getSession']);
  });

  it('keeps the stored session when getSession() times out', async () => {
    const store = await freshStore();
    await store.getState().init();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.getState()).toMatchObject({ userEmail: USER.email, sessionUnverified: true });
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('clears the flag and does the follow-up work once getSession() confirms it', async () => {
    let answer!: (v: Awaited<ReturnType<GetSession>>) => void;
    h.getSession = () => new Promise((r) => (answer = r));
    const store = await freshStore();
    await store.getState().init();
    answer({ data: { session: SESSION }, error: null });
    await flush();
    expect(store.getState()).toMatchObject({ userEmail: USER.email, sessionUnverified: false });
    expect(h.syncEntitlement).toHaveBeenCalledWith('user-1');
    expect(h.drain).toHaveBeenCalled();
  });
});

describe('the auth listener while the stored session is unconfirmed (LL#65)', () => {
  beforeEach(() => {
    h.stored = { user: USER, expiresAt: 0, expired: true };
  });

  it('ignores INITIAL_SESSION with no session — the refresh failed, the account did not', async () => {
    const store = await freshStore();
    await store.getState().init();
    h.listener!('INITIAL_SESSION', null);
    expect(store.getState()).toMatchObject({ userEmail: USER.email, userName: 'Lee Lifter', sessionUnverified: true });
    expect(h.syncEntitlement).not.toHaveBeenCalled();
  });

  it('still signs out on a real SIGNED_OUT', async () => {
    const store = await freshStore();
    await store.getState().init();
    h.listener!('SIGNED_OUT', null);
    expect(store.getState()).toMatchObject({ userEmail: null, userName: null, sessionUnverified: false });
    expect(h.syncEntitlement).toHaveBeenCalledWith(null);
  });

  it('confirms on TOKEN_REFRESHED and lets the queued work go', async () => {
    const store = await freshStore();
    await store.getState().init();
    h.listener!('TOKEN_REFRESHED', SESSION);
    expect(store.getState()).toMatchObject({ userEmail: USER.email, sessionUnverified: false });
    expect(h.drain).toHaveBeenCalledTimes(1);
  });

  it('confirms on INITIAL_SESSION that carries a session', async () => {
    const store = await freshStore();
    await store.getState().init();
    h.listener!('INITIAL_SESSION', SESSION);
    expect(store.getState().sessionUnverified).toBe(false);
  });

  it('treats INITIAL_SESSION with no session as signed out once nothing is pending', async () => {
    h.stored = null;
    h.getSession = async () => ({ data: { session: null }, error: null });
    h.native = false; // no inherit
    const store = await freshStore();
    await store.getState().init();
    store.setState({ userEmail: 'stale@example.com' });
    h.listener!('INITIAL_SESSION', null);
    expect(store.getState().userEmail).toBeNull();
  });
});

describe('init() with nothing in storage', () => {
  beforeEach(() => {
    h.getSession = async () => ({ data: { session: null }, error: null });
  });

  it('bounds the Nexus inherit at 3 s instead of holding the launch on it (LL#64)', async () => {
    const store = await freshStore();
    let done = false;
    const init = store.getState().init().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await init;
    expect(store.getState()).toMatchObject({ userEmail: null, sessionUnverified: false, loading: false });
  });

  it('an inherit that lands after the bound still signs in, through the listener', async () => {
    const store = await freshStore();
    const init = store.getState().init();
    await vi.advanceTimersByTimeAsync(3000);
    await init;
    h.listener!('SIGNED_IN', SESSION);
    expect(store.getState().userEmail).toBe(USER.email);
    expect(h.setGuestMode).toHaveBeenCalledWith(false);
    expect(h.syncEntitlement).toHaveBeenCalledWith('user-1', { force: true });
  });

  it('does not overwrite a sign-in that landed while it was still waiting', async () => {
    h.inherit = () => new Promise(() => h.listener!('SIGNED_IN', SESSION)); // SIGNED_IN, then the bound
    const store = await freshStore();
    const init = store.getState().init();
    await vi.advanceTimersByTimeAsync(3000);
    await init;
    expect(store.getState()).toMatchObject({ userEmail: USER.email, loading: false });
  });

  it('skips the inherit in guest mode, as before', async () => {
    h.guest = true;
    const inherit = vi.fn(h.inherit);
    h.inherit = inherit;
    const store = await freshStore();
    await store.getState().init();
    expect(inherit).not.toHaveBeenCalled();
    expect(store.getState().loading).toBe(false);
  });
});
