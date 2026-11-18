import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// v1.21.1 (limecore#102) — Delete account never pretends. An account recorded
// on the device with no usable session is refused with nothing wiped and no
// function called; a real guest is wiped; a real delete also removes the
// stored auth session.

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  invoke: vi.fn(),
  signOut: vi.fn(async (_o?: unknown) => ({ error: null })),
  stored: null as unknown,
  clearStored: vi.fn(async () => {}),
}));

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  readStoredSession: async () => h.stored,
  clearStoredSession: h.clearStored,
  supabase: {
    auth: { getSession: h.getSession, signOut: h.signOut },
    functions: { invoke: h.invoke },
  },
}));

import { deleteAccount, SESSION_TIMEOUT_MS } from './dataRights';

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const SESSION = { user: { id: 'user-1' } };
let clearLocal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  h.getSession.mockReset();
  h.invoke.mockReset();
  h.signOut.mockClear();
  h.clearStored.mockClear();
  h.stored = null;
  clearLocal = vi.fn(async () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('deleteAccount', () => {
  it('a refresh failure with an owner recorded wipes nothing and calls no function', async () => {
    localStorage.setItem('limelog.dataOwner', 'user-1');
    h.getSession.mockResolvedValue({ data: { session: null }, error: { message: 'Invalid Refresh Token' } });
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'none' });
    expect(clearLocal).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem('limelog.dataOwner')).toBe('user-1');
  });

  it('no session but an owner recorded (session ended) is refused too', async () => {
    localStorage.setItem('limelog.dataOwner', 'user-1');
    h.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'none' });
    expect(clearLocal).not.toHaveBeenCalled();
  });

  it('a session still in auth storage counts as an account', async () => {
    h.stored = { user: { id: 'user-1' }, expiresAt: 0, expired: true };
    h.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'none' });
    expect(clearLocal).not.toHaveBeenCalled();
  });

  it('getSession throwing is refused, not treated as a guest', async () => {
    h.getSession.mockRejectedValue(new Error('network'));
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'none' });
    expect(clearLocal).not.toHaveBeenCalled();
  });

  it('a real guest wipes the device and calls no function', async () => {
    h.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'local' });
    expect(clearLocal).toHaveBeenCalledTimes(1);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('a successful delete signs out locally and clears the stored session', async () => {
    localStorage.setItem('limelog.dataOwner', 'user-1');
    h.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    h.invoke.mockResolvedValue({ error: null });
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'account' });
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(h.clearStored).toHaveBeenCalled();
    expect(clearLocal).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('limelog.dataOwner')).toBeNull();
  });

  // limecore#124 — offline with an expired session, getSession() never returns.
  it('a getSession that never resolves is refused within the bound, with no call and no wipe', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem('limelog.dataOwner', 'user-1');
      h.getSession.mockReturnValue(new Promise(() => {}));
      let result: unknown = 'pending';
      const run = deleteAccount({ clearLocal }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS - 1);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(result).toEqual({ deleted: 'none' });
      expect(h.invoke).not.toHaveBeenCalled();
      expect(clearLocal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline with an account: refused at once, without asking for the session', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    localStorage.setItem('limelog.dataOwner', 'user-1');
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'none' });
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(clearLocal).not.toHaveBeenCalled();
  });

  it('offline as a guest: the device is still erased', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(await deleteAccount({ clearLocal })).toEqual({ deleted: 'local' });
    expect(h.getSession).not.toHaveBeenCalled();
    expect(clearLocal).toHaveBeenCalledTimes(1);
  });

  it('a failed function call throws and wipes nothing', async () => {
    h.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    h.invoke.mockResolvedValue({ error: { message: 'boom' } });
    await expect(deleteAccount({ clearLocal })).rejects.toThrow('boom');
    expect(clearLocal).not.toHaveBeenCalled();
    expect(h.clearStored).not.toHaveBeenCalled();
  });
});
