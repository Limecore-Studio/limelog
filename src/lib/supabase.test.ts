import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.19 (LL#64) — the stored-session reader that lets a cold start render
// before auth-js has answered. It must read exactly what the client persisted,
// from the same adapter, and never touch the network: the client is a stub
// with no auth methods, so any call into it would throw and fail the read.

const h = vi.hoisted(() => ({ native: true, prefs: new Map<string, string>() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove() {} }) } }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: h.prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => void h.prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void h.prefs.delete(key),
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}
vi.stubGlobal('localStorage', storage());

const { readStoredSession, parseStoredSession, clearStoredSession, storedRefreshToken } = await import('./supabase');

const KEY = 'wt_nexus_auth';
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const USER = { id: 'user-1', email: 'lifter@example.com', user_metadata: { full_name: 'Lee Lifter' } };
/** What auth-js persists (no separate userStorage configured). */
const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    access_token: 'at',
    refresh_token: 'rt',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: NOW / 1000 + 3600,
    user: USER,
    ...over,
  });

beforeEach(() => {
  h.native = true;
  h.prefs.clear();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('readStoredSession', () => {
  it('returns the stored user and expiry, unexpired', async () => {
    h.prefs.set(KEY, entry());
    const s = await readStoredSession();
    expect(s).toEqual({ user: USER, expiresAt: NOW / 1000 + 3600, expired: false });
  });

  it('is null when nothing is stored (fresh install, signed out)', async () => {
    expect(await readStoredSession()).toBeNull();
  });

  it('is null for a malformed entry rather than throwing', async () => {
    h.prefs.set(KEY, '{not json');
    expect(await readStoredSession()).toBeNull();
    for (const raw of ['null', '42', '"text"', '[]']) expect(parseStoredSession(raw, NOW)).toBeNull();
  });

  it('is null for an entry auth-js would not accept, or with no user to show', async () => {
    expect(parseStoredSession(entry({ refresh_token: undefined }), NOW)).toBeNull();
    expect(parseStoredSession(entry({ access_token: '' }), NOW)).toBeNull();
    expect(parseStoredSession(entry({ expires_at: undefined }), NOW)).toBeNull();
    expect(parseStoredSession(entry({ user: undefined }), NOW)).toBeNull();
    expect(parseStoredSession(entry({ user: { email: 'no-id@example.com' } }), NOW)).toBeNull();
  });

  it('still returns an expired session, flagged — that is the offline case it exists for', async () => {
    h.prefs.set(KEY, entry({ expires_at: NOW / 1000 - 7200 }));
    const s = await readStoredSession();
    expect(s?.user.email).toBe(USER.email);
    expect(s?.expired).toBe(true);
  });

  it("uses auth-js's 90 s margin, so 'expired' means getSession() will refresh", () => {
    expect(parseStoredSession(entry({ expires_at: NOW / 1000 + 89 }), NOW)?.expired).toBe(true);
    expect(parseStoredSession(entry({ expires_at: NOW / 1000 + 91 }), NOW)?.expired).toBe(false);
  });

  it('reads through the adapter: a pre-Preferences install still has its session', async () => {
    localStorage.setItem(KEY, entry());
    expect((await readStoredSession())?.user.id).toBe('user-1');
  });

  it('reads localStorage on the web, where the client keeps it', async () => {
    h.native = false;
    h.prefs.set(KEY, entry({ user: { id: 'wrong-store' } }));
    localStorage.setItem(KEY, entry());
    expect((await readStoredSession())?.user.id).toBe('user-1');
  });
});

// v1.18.1 (LimeLog#66) — a sign-out that cannot reach the server removes the
// stored session itself; its late clean-up must not take a newer sign-in.
describe('clearStoredSession', () => {
  it('removes the session and the PKCE verifier, on native and on the web', async () => {
    h.prefs.set(KEY, entry());
    h.prefs.set(`${KEY}-code-verifier`, 'v');
    await clearStoredSession();
    expect(h.prefs.has(KEY)).toBe(false);
    expect(h.prefs.has(`${KEY}-code-verifier`)).toBe(false);
    h.native = false;
    localStorage.setItem(KEY, entry());
    await clearStoredSession();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('with a token, removes the session only if it is still that one', async () => {
    h.prefs.set(KEY, entry({ refresh_token: 'new-sign-in' }));
    await clearStoredSession('signed-out');
    expect(h.prefs.has(KEY)).toBe(true);
    h.prefs.set(KEY, entry({ refresh_token: 'signed-out' }));
    await clearStoredSession('signed-out');
    expect(h.prefs.has(KEY)).toBe(false);
  });

  it('storedRefreshToken reads it without asking anyone', async () => {
    expect(await storedRefreshToken()).toBeUndefined();
    h.prefs.set(KEY, entry());
    expect(await storedRefreshToken()).toBe('rt');
  });
});
