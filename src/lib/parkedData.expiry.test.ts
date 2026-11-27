import { describe, it, expect, vi } from 'vitest';

// v1.22 (limecore#99) — a parked slot older than 90 days is dropped.

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
const { parkedFor: readSlot, PARKED_KEY, SLOT_MAX_AGE_MS } = await import('./parkedData');

describe('parked slots', () => {
  it('keeps a recent slot and drops one past the age limit', () => {
    const now = Date.now();
    localStorage.setItem(PARKED_KEY, JSON.stringify({
      fresh: { prs: [], profile: null, parkedAt: new Date(now - 1000).toISOString() },
      stale: { prs: [], profile: null, parkedAt: new Date(now - SLOT_MAX_AGE_MS - 1000).toISOString() },
    }));
    expect(readSlot('fresh')).not.toBeNull();
    expect(readSlot('stale')).toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem(PARKED_KEY) ?? '{}'))).toEqual(['fresh']);
  });
});
