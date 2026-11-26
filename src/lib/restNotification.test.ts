import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#127 item 4) — Skip / +30 s on the rest notification.
const h = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    show: async (o: unknown) => void h.calls.push(['show', o]),
    hide: async () => void h.calls.push(['hide']),
    consumeActions: async () => ({ actions: [] }),
    addListener: async () => ({ remove() {} }),
  }),
}));
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
vi.stubGlobal('window', { dispatchEvent: vi.fn() });
const { applyRestAction } = await import('./restNotification');
const { saveActiveRest, loadActiveRest } = await import('./activeRest');

const now = 1_000_000;

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  h.calls = [];
});

describe('applyRestAction', () => {
  it('+30 s moves the end and grows the rest; the notification follows', async () => {
    saveActiveRest({ endsAt: now + 40_000, total: 90, exerciseName: 'Row' }, 'w1');
    applyRestAction('plus30', now);
    expect(loadActiveRest()).toMatchObject({ endsAt: now + 70_000, total: 120, logId: 'w1' });
    await vi.waitFor(() => expect(h.calls[h.calls.length - 1]).toEqual(['show', expect.objectContaining({ endsAt: now + 70_000 })]));
  });

  it('+30 s after the end counts from now', () => {
    saveActiveRest({ endsAt: now - 5_000, total: 90, exerciseName: 'Row' }, 'w1');
    applyRestAction('plus30', now);
    expect(loadActiveRest()?.endsAt).toBe(now + 30_000);
  });

  it('Skip ends the rest and removes the notification', async () => {
    saveActiveRest({ endsAt: now + 40_000, total: 90, exerciseName: 'Row' }, 'w1');
    applyRestAction('skip', now);
    expect(loadActiveRest()).toBeNull();
    await vi.waitFor(() => expect(h.calls[h.calls.length - 1]).toEqual(['hide']));
  });

  it('does nothing with no rest running, or for an unknown action', () => {
    applyRestAction('skip', now);
    expect(loadActiveRest()).toBeNull();
    saveActiveRest({ endsAt: now + 40_000, total: 90, exerciseName: 'Row' }, 'w1');
    applyRestAction('reboot', now);
    expect(loadActiveRest()?.endsAt).toBe(now + 40_000);
  });
});
