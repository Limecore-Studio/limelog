import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.21.1 (limecore#101, limecore#111) — the Nexus inherit never hands NCC's
// refresh token to this app's client, never calls the function with a token
// that has already expired, and the startup path never adopts another account.

const h = vi.hoisted(() => ({
  bundle: null as null | Record<string, unknown>,
  invoke: vi.fn(),
  setSession: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(async () => ({ error: null as null | { message: string } })),
  fetch: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    getNexusSession: async () =>
      h.bundle ? { available: true, bundleJson: JSON.stringify(h.bundle), publishedAt: 1 } : { available: false },
    openNexus: async () => ({ opened: true }),
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: h.invoke },
    auth: { setSession: h.setSession, verifyOtp: h.verifyOtp },
  },
}));

import { inheritFromNexus, tokenUserId } from './suiteSso';

const b64url = (o: object) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub: string) => `${b64url({ alg: 'ES256' })}.${b64url({ sub })}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);

function bundle(over: Record<string, unknown> = {}) {
  return { access_token: jwt('user-1'), refresh_token: 'ncc-refresh', expires_at: nowS() + 3600, email: 'a@b.c', ...over };
}

beforeEach(() => {
  h.invoke.mockReset();
  h.setSession.mockClear();
  h.verifyOtp.mockClear();
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('inheritFromNexus', () => {
  it('an expired bundle makes no request and never calls setSession', async () => {
    h.bundle = bundle({ expires_at: nowS() - 10 });
    expect(await inheritFromNexus()).toEqual({ ok: false, reason: 'nexus-stale' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.setSession).not.toHaveBeenCalled();
  });

  it('a bundle about to expire, or without an expiry, counts as stale', async () => {
    h.bundle = bundle({ expires_at: nowS() + 20 });
    expect((await inheritFromNexus()).reason).toBe('nexus-stale');
    h.bundle = bundle({ expires_at: undefined });
    expect((await inheritFromNexus()).reason).toBe('nexus-stale');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('a 401 from suite-session fails and never reaches setSession', async () => {
    h.bundle = bundle();
    h.invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { name: 'FunctionsHttpError' }) });
    const r = await inheritFromNexus();
    expect(r.ok).toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.setSession).not.toHaveBeenCalled();
  });

  it('a rejected one-time credential fails and never reaches setSession', async () => {
    h.bundle = bundle();
    h.invoke.mockResolvedValue({ data: { token_hash: 'th' }, error: null });
    h.verifyOtp.mockResolvedValue({ error: { message: 'One-time token not found' } });
    expect((await inheritFromNexus()).ok).toBe(false);
    expect(h.setSession).not.toHaveBeenCalled();
  });

  it('a thrown error fails and never reaches setSession', async () => {
    h.bundle = bundle();
    h.invoke.mockRejectedValue(new Error('boom'));
    expect((await inheritFromNexus()).ok).toBe(false);
    expect(h.setSession).not.toHaveBeenCalled();
  });

  it('sends only the access token and redeems the credential', async () => {
    h.bundle = bundle();
    h.invoke.mockResolvedValue({ data: { token_hash: 'th' }, error: null });
    h.verifyOtp.mockResolvedValue({ error: null });
    expect(await inheritFromNexus()).toEqual({ ok: true, email: 'a@b.c' });
    const [, opts] = h.invoke.mock.calls[0];
    expect(JSON.stringify(opts)).not.toContain('ncc-refresh');
    expect(h.setSession).not.toHaveBeenCalled();
  });

  it('refuses a bundle for an account other than the recorded owner (limecore#111)', async () => {
    h.bundle = bundle({ access_token: jwt('someone-else') });
    expect(await inheritFromNexus({ onlyUserId: 'user-1' })).toEqual({ ok: false, reason: 'other-account', email: 'a@b.c' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.setSession).not.toHaveBeenCalled();
  });

  it('accepts the recorded owner, and anyone when no owner is recorded', async () => {
    h.invoke.mockResolvedValue({ data: { token_hash: 'th' }, error: null });
    h.verifyOtp.mockResolvedValue({ error: null });
    h.bundle = bundle();
    expect((await inheritFromNexus({ onlyUserId: 'user-1' })).ok).toBe(true);
    expect((await inheritFromNexus({ onlyUserId: null })).ok).toBe(true);
  });

  it('an unreadable token counts as another account', async () => {
    h.bundle = bundle({ access_token: 'not-a-jwt' });
    expect((await inheritFromNexus({ onlyUserId: 'user-1' })).reason).toBe('other-account');
  });
});

describe('tokenUserId', () => {
  it('reads sub from a base64url payload', () => {
    expect(tokenUserId(jwt('abc-123'))).toBe('abc-123');
    expect(tokenUserId('x')).toBeNull();
  });
});

// v1.22 (limecore#113) — reasons are codes; the screen shows a translated
// string, never the plugin's or the server's own text.
describe('nexusErrorKey', () => {
  it('maps each reason code to an auth.nexusErr key', async () => {
    const { nexusErrorKey } = await import('./suiteSso');
    expect(nexusErrorKey('not-android')).toBe('auth.nexusErr.unavailable');
    expect(nexusErrorKey('unavailable')).toBe('auth.nexusErr.unavailable');
    expect(nexusErrorKey('no-session')).toBe('auth.nexusErr.noSession');
    expect(nexusErrorKey('offline')).toBe('auth.nexusErr.offline');
    expect(nexusErrorKey('timeout')).toBe('auth.nexusErr.timedOut');
    expect(nexusErrorKey('malformed')).toBe('auth.nexusErr.failed');
    expect(nexusErrorKey(undefined)).toBe('auth.nexusErr.failed');
  });
});
