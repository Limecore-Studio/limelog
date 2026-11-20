import { describe, it, expect, beforeEach, vi } from 'vitest';

// v1.22 (limecore#130) — the haptic helper: native only, and the right kind.
const h = vi.hoisted(() => ({ native: true, calls: [] as unknown[] }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }));
vi.mock('@capacitor/haptics', () => ({
  ImpactStyle: { Light: 'LIGHT' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING' },
  Haptics: {
    impact: async (o: unknown) => void h.calls.push(['impact', o]),
    notification: async (o: unknown) => void h.calls.push(['notification', o]),
  },
}));
const { haptic } = await import('./haptic');
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.native = true;
  h.calls = [];
});

describe('haptic', () => {
  it('light is a light impact; success and warning are notifications', async () => {
    haptic.light();
    haptic.success();
    haptic.warning();
    await settle();
    expect(h.calls).toEqual([
      ['impact', { style: 'LIGHT' }],
      ['notification', { type: 'SUCCESS' }],
      ['notification', { type: 'WARNING' }],
    ]);
  });

  it('does nothing on the web build', async () => {
    h.native = false;
    haptic.light();
    await settle();
    expect(h.calls).toEqual([]);
  });
});
