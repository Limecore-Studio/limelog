import { describe, it, expect, vi } from 'vitest';

// v1.22 (limecore#127) — deep links into the router.
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/app', () => ({ App: {} }));
const { routeForDeepLink, onDeepLink, deliverForTest } = await import('./deepLinks');

const L = (p: string) => `com.limecore.workouttracker://open/${p}`;

describe('routeForDeepLink', () => {
  it('maps the known routes', () => {
    expect(routeForDeepLink(L('today'))).toBe('/today');
    expect(routeForDeepLink(L('today?start=1'))).toBe('/today?start=1');
    expect(routeForDeepLink(L('progress'))).toBe('/progress');
    expect(routeForDeepLink(L('body?add=1'))).toBe('/body?add=1');
    expect(routeForDeepLink(L('workout/0b7d6f1c-2a4e-4c9a-8e3f-2d5b1a7c9e02'))).toBe('/workout/0b7d6f1c-2a4e-4c9a-8e3f-2d5b1a7c9e02');
  });

  it('refuses anything else: other routes, paths, ids, schemes and the auth callback', () => {
    for (const bad of [
      L('profile'),
      L('today/extra'),
      L('workout'),
      L('workout/../profile'),
      L('workout/a b'),
      L('workout/x/y'),
      'com.limecore.workouttracker://auth/callback?code=x',
      'https://evil.example/open/today',
      'com.limecore.nexus://open/today',
    ]) {
      expect(routeForDeepLink(bad), bad).toBeNull();
    }
  });

  it('ignores query values it does not know', () => {
    expect(routeForDeepLink(L('today?start=yes'))).toBe('/today');
    expect(routeForDeepLink(L('progress?redirect=https://x'))).toBe('/progress');
  });
});

describe('onDeepLink', () => {
  it('a link that comes before the router (sign-in showing) is held, then delivered once', () => {
    deliverForTest(L('progress'));
    const seen: string[] = [];
    const off = onDeepLink((r) => seen.push(r));
    deliverForTest(L('today'));
    off();
    expect(seen).toEqual(['/progress', '/today']);
    const again: string[] = [];
    onDeepLink((r) => again.push(r))();
    expect(again).toEqual([]);
  });
});
