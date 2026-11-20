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

beforeEach(() => {
  h.native = true;
  h.calls = [];
});

describe('haptic', () => {
  it('light is a light impact; success and warning are notifications', async () => {
    haptic.light();
    haptic.success();
    haptic.warning();
    // The plugin is imported on first use; how soon that settles varies (CI).
    await vi.waitFor(() => expect(h.calls).toHaveLength(3), { timeout: 5000 });
    expect(h.calls).toEqual(expect.arrayContaining([
      ['impact', { style: 'LIGHT' }],
      ['notification', { type: 'SUCCESS' }],
      ['notification', { type: 'WARNING' }],
    ]));
  });

  it('does nothing on the web build', async () => {
    h.native = false;
    haptic.light();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls).toEqual([]);
  });
});
