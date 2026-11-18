import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.21.1 (limecore#87) — the app-open record is opt-in: nothing is queued or
// sent until this account said yes, an existing install counts as not asked,
// and the answer belongs to the account, not the device.

const h = vi.hoisted(() => ({
  session: { user: { id: 'user-1' } } as null | { user: { id: string } },
  enqueue: vi.fn(),
}));

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }));
vi.mock('./outbox', () => ({ enqueue: h.enqueue }));
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  supabase: { auth: { getSession: async () => ({ data: { session: h.session } }) } },
}));

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

const { recordAppOpen } = await import('./appOpens');
const { setConsent, unanswered, hasConsent } = await import('./consent');

beforeEach(() => {
  localStorage.clear();
  h.enqueue.mockClear();
  h.session = { user: { id: 'user-1' } };
});

describe('recordAppOpen (limecore#87)', () => {
  it('queues nothing for an account that was never asked', async () => {
    expect(await recordAppOpen('1.21.1')).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('queues nothing after a no', async () => {
    setConsent({ appOpens: false }, 'user-1');
    expect(await recordAppOpen('1.21.1')).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('queues once a day after a yes', async () => {
    setConsent({ appOpens: true }, 'user-1');
    expect(await recordAppOpen('1.21.1')).toBe(true);
    expect(await recordAppOpen('1.21.1')).toBe(false);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0]).toBe('record_app_open');
  });

  it("another account's yes does not count", async () => {
    setConsent({ appOpens: true }, 'user-2');
    expect(await recordAppOpen('1.21.1')).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('consent records', () => {
  it('lists what an owner has not answered, and keeps owners apart', () => {
    expect(unanswered(['appOpens', 'updateCheck'], 'user-1')).toEqual(['appOpens', 'updateCheck']);
    setConsent({ updateCheck: false }, 'user-1');
    expect(unanswered(['appOpens', 'updateCheck'], 'user-1')).toEqual(['appOpens']);
    expect(hasConsent('updateCheck', 'user-1')).toBe(false);
    expect(unanswered(['updateCheck'], 'guest')).toEqual(['updateCheck']);
  });

  it('an unreadable record means no', () => {
    localStorage.setItem('limelog.consent.user-1', '{not json');
    expect(hasConsent('appOpens', 'user-1')).toBe(false);
  });
});
