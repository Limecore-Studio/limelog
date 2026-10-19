import { describe, it, expect, vi, beforeEach } from 'vitest';

// v1.19 (LimeLog#67 review) — a cold start whose token refresh was refused
// emits SIGNED_OUT before the NCC inherit signs the user back in, and
// SIGNED_OUT ends the entitlement. setEntitled(false) used to SAVE 'lime',
// so a supporter's chosen theme was lost for good on that path.

const h = vi.hoisted(() => ({ saved: 'cast-iron' as string, entitled: true, applied: [] as string[] }));
vi.mock('@/utils/storage', () => ({
  storage: { getTheme: () => h.saved, setTheme: (t: string) => { h.saved = t; } },
}));
vi.mock('@/lib/entitlement', () => ({
  isEntitled: () => h.entitled,
  refreshEntitlement: async () => h.entitled,
}));
vi.stubGlobal('document', {
  documentElement: { dataset: {}, setAttribute: (_k: string, v: string) => h.applied.push(v), classList: { add() {}, remove() {}, toggle() {} }, style: {} },
  querySelector: () => null,
});
vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));

const { useThemeStore } = await import('./themeStore');

beforeEach(() => {
  h.saved = 'cast-iron';
  h.entitled = true;
  useThemeStore.setState({ theme: 'cast-iron', entitled: true });
});

describe('theme across a lapse in entitlement', () => {
  it('shows the free theme without forgetting the chosen one, and restores it', () => {
    h.entitled = false;
    useThemeStore.getState().setEntitled(false);
    expect(useThemeStore.getState().theme).toBe('lime');
    expect(h.saved).toBe('cast-iron');

    h.entitled = true;
    useThemeStore.getState().setEntitled(true);
    expect(useThemeStore.getState().theme).toBe('cast-iron');
  });

  it('a user who chose the free theme keeps it when entitlement returns', () => {
    useThemeStore.getState().setTheme('lime');
    expect(h.saved).toBe('lime');
    useThemeStore.getState().setEntitled(true);
    expect(useThemeStore.getState().theme).toBe('lime');
  });
});
