import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionLog } from '@/types/logging';
import type { RecoveryAuthState } from './recoveryGate';

// v1.18.1 (LimeLog#85) — the recovery pull ran once per launch. Signing out
// (which wipes the local history) and back in during the same launch left the
// history empty until a restart. These drive the real nexusStore through its
// auth listener and sign-out, with the gate subscribed the way App.tsx does
// it; everything below the store is a stand-in.

type User = { id: string; email: string; user_metadata: Record<string, unknown> };
type Session = { user: User };
type Listener = (event: string, session: Session | null) => void;

const h = vi.hoisted(() => ({
  stored: null as null | { user: User; expiresAt: number; expired: boolean },
  getSession: (() => new Promise(() => {})) as () => Promise<{ data: { session: Session | null }; error: null }>,
  listener: null as Listener | null,
  signOut: (() => Promise.resolve({ error: null })) as () => Promise<{ error: { message: string } | null }>,
}));

// v1.18.1 (LimeLog#92) — accountOwner mirrors the owner record into Preferences.
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  readStoredSession: async () => h.stored,
  clearStoredSession: vi.fn(async () => {}),
  storedRefreshToken: async () => 'rt-old',
  supabase: {
    auth: {
      signOut: () => h.signOut(),
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
vi.mock('@/lib/guestMode', () => ({ isGuestMode: () => false, setGuestMode: vi.fn(async () => {}) }));
vi.mock('@/lib/suiteSso', () => ({ inheritFromNexus: () => new Promise(() => {}) }));
vi.mock('@/lib/originMarker', () => ({ scheduleOriginStamp: vi.fn() }));
vi.mock('@/lib/appOpens', () => ({ watchAppOpens: vi.fn(), recordAppOpen: vi.fn(async () => true), forgetLastAppOpen: vi.fn() }));
vi.mock('@/lib/onboarding', () => ({ releaseOnboardingOnSignOut: vi.fn() }));
vi.mock('@/lib/referralSource', () => ({ forgetReferralAskedLocally: vi.fn() }));
vi.mock('@/lib/entitlement', () => ({ clearEntitlement: vi.fn() }));
vi.mock('@/lib/outbox', () => ({
  drain: vi.fn(async () => ({ sent: 0, remaining: 0 })),
  getStatus: () => ({ pending: 0, lastSuccessAt: null, lastError: null, lastErrorAt: null, oldestEnqueuedAt: null, stuck: 0 }),
  clear: vi.fn(),
  installDrainTriggers: vi.fn(),
}));
vi.mock('@/store/themeStore', () => ({ useThemeStore: { getState: () => ({ syncEntitlement: vi.fn(async () => {}) }) } }));
vi.mock('@/store/logStore', () => ({ useLogStore: { setState: vi.fn() } }));
vi.mock('@/store/bodyMetricsStore', () => ({ useBodyMetricsStore: { setState: vi.fn() } }));
vi.mock('@/types/bodyMetrics', () => ({ DEFAULT_PREFS: {} }));

const A: Session = { user: { id: 'user-a', email: 'a@example.com', user_metadata: {} } };
const B: Session = { user: { id: 'user-b', email: 'b@example.com', user_metadata: {} } };
const logOf = (id: string) => ({ id }) as SessionLog;

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** A pull per call that the test resolves by hand. */
function heldPulls() {
  const calls: { userId: string; resolve: (logs: SessionLog[]) => void }[] = [];
  const pull = vi.fn(
    (userId: string) => new Promise<SessionLog[]>((resolve) => void calls.push({ userId, resolve })),
  );
  return { calls, pull };
}

/** The store after a launch on A's stored session, with the gate wired as in
 *  App.tsx: evaluated once init resolves, then on every store change. */
async function launch(pull: (userId: string) => Promise<SessionLog[]>) {
  vi.resetModules();
  const { useNexusStore } = await import('@/store/nexusStore');
  const { createRecoveryGate } = await import('./recoveryGate');
  const apply = vi.fn((logs: SessionLog[]) => logs.length);
  const gate = createRecoveryGate({ read: () => useNexusStore.getState(), pull, apply });
  await useNexusStore.getState().init();
  gate.evaluate();
  useNexusStore.subscribe(() => gate.evaluate());
  return { store: useNexusStore, apply };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.stored = { user: A.user, expiresAt: 0, expired: false };
  h.getSession = () => new Promise(() => {});
  h.listener = null;
  h.signOut = () => Promise.resolve({ error: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recovery pull, once per sign-in (LimeLog#85)', () => {
  it('waits for the stored session to be confirmed, then pulls once, outside the auth listener', async () => {
    const pull = vi.fn(async () => [logOf('w1')]);
    const { apply } = await launch(pull);
    await flush();
    expect(pull).not.toHaveBeenCalled(); // unverified (LL#64)
    h.listener!('TOKEN_REFRESHED', A);
    // Deferred: the pull asks auth-js for the user, and auth-js holds its lock
    // while the listener runs.
    expect(pull).not.toHaveBeenCalled();
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith('user-a');
    expect(apply).toHaveBeenCalledWith([logOf('w1')]);
  });

  it('a token refresh or a resume of the same account does not pull again', async () => {
    const pull = vi.fn(async () => []);
    await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    // auth-js emits SIGNED_IN when the app comes back to the foreground.
    h.listener!('SIGNED_IN', A);
    await flush();
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    h.listener!('USER_UPDATED', { user: { ...A.user, email: 'a-new@example.com' } });
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('signing out and back in as the same account pulls again, once', async () => {
    const pull = vi.fn(async () => [logOf('w1')]);
    const { store, apply } = await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    await store.getState().signOut();
    h.listener!('SIGNED_OUT', null);
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
    h.listener!('SIGNED_IN', A);
    await flush();
    h.listener!('SIGNED_IN', A); // and the resume after it
    await flush();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('signing out and in as another account pulls for that account', async () => {
    const pull = vi.fn(async () => []);
    const { store } = await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    await store.getState().signOut();
    h.listener!('SIGNED_IN', B);
    await flush();
    expect(pull.mock.calls).toEqual([['user-a'], ['user-b']]);
  });

  it("A's pull finishing after B signed in is dropped; B's lands", async () => {
    const { calls, pull } = heldPulls();
    const { store, apply } = await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    await store.getState().signOut();
    h.listener!('SIGNED_IN', B);
    await flush();
    calls[0].resolve([logOf('a-workout')]); // A's, late
    await flush();
    expect(apply).not.toHaveBeenCalled();
    calls[1].resolve([logOf('b-workout')]);
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([logOf('b-workout')]);
  });

  it('drops A\'s result when B signs in over A with no sign-out between', async () => {
    const { calls, pull } = heldPulls();
    const { apply } = await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    h.listener!('SIGNED_IN', B);
    await flush();
    calls[0].resolve([logOf('a-workout')]);
    calls[1].resolve([logOf('b-workout')]);
    await flush();
    expect(apply.mock.calls).toEqual([[[logOf('b-workout')]]]);
  });

  it('a pull still running when sign-out wipes the logs does not refill them', async () => {
    const { calls, pull } = heldPulls();
    const { store, apply } = await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    const done = store.getState().signOut();
    calls[0].resolve([logOf('a-workout')]); // lands mid-sign-out, after the wipe
    await flush();
    await done;
    await flush();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not start while an offline sign-out is still settling', async () => {
    h.signOut = () => new Promise(() => {}); // the server never answers
    const pull = vi.fn(async () => []);
    const { store } = await launch(pull);
    h.listener!('TOKEN_REFRESHED', A);
    await flush();
    const done = store.getState().signOut();
    // During the call, and during the hold after it gave up waiting.
    expect(store.getState().signingOut).toBe(true);
    h.listener!('TOKEN_REFRESHED', A); // a refresh in flight re-saving the session: ignored
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(store.getState()).toMatchObject({ signingOut: false, signOutPending: true, userId: null });
    h.listener!('SIGNED_IN', A); // ignored by the hold
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
  });
});

describe('createRecoveryGate on its own', () => {
  async function gateOver(state: Partial<RecoveryAuthState>) {
    const { createRecoveryGate } = await import('./recoveryGate');
    const s: RecoveryAuthState = { configured: true, userId: 'user-a', sessionUnverified: false, signingOut: false, signOutPending: false, ...state };
    const pull = vi.fn(async () => [] as SessionLog[]);
    const gate = createRecoveryGate({ read: () => s, pull, apply: () => 0 });
    return { s, pull, gate };
  }

  it('evaluated again for the same account, it does not pull again', async () => {
    const { pull, gate } = await gateOver({});
    gate.evaluate();
    gate.evaluate();
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('a failed pull is not retried until the next sign-in', async () => {
    const { s, pull, gate } = await gateOver({});
    pull.mockRejectedValueOnce(new Error('offline'));
    gate.evaluate();
    await flush();
    gate.evaluate();
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
    s.userId = null;
    gate.evaluate();
    s.userId = 'user-a';
    gate.evaluate();
    await flush();
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('does nothing when Nexus is not configured', async () => {
    const { pull, gate } = await gateOver({ configured: false });
    gate.evaluate();
    await flush();
    expect(pull).not.toHaveBeenCalled();
  });
});
