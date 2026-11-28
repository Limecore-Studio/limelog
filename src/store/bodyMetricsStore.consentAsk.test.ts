import { describe, it, expect, beforeEach, vi } from 'vitest';

// limelog#185 — the health-data question is asked when a body-composition
// reading is saved signed in with sync on, and never for a guest, who has
// nothing on the server to ask about.

const h = vi.hoisted(() => ({ owner: null as string | null, asks: 0, consent: 'unasked' }));
vi.mock('@/lib/outbox', () => ({ enqueue: () => {} }));
vi.mock('@/lib/syncSetting', () => ({ syncAllowed: () => true }));
vi.mock('@/lib/accountOwner', () => ({ readOwner: () => h.owner }));
vi.mock('@/lib/healthConsent', () => ({
  healthConsent: () => h.consent,
  requestHealthAsk: () => void h.asks++,
  HEALTH_BODY_FIELDS: ['bodyFatPct', 'waterPct', 'proteinPct', 'bmrKcal', 'visceralFat', 'boneMassKg', 'muscleMassKg', 'bodyAge'],
}));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());

const { useBodyMetricsStore } = await import('./bodyMetricsStore');

beforeEach(() => {
  h.owner = null;
  h.asks = 0;
  h.consent = 'unasked';
  useBodyMetricsStore.setState({ metrics: [] });
});

describe('health-data question on a body-composition reading', () => {
  it('is not asked for a guest', () => {
    useBodyMetricsStore.getState().addOrUpdate({ date: '2026-11-28', bodyFatPct: 18 });
    expect(h.asks).toBe(0);
  });

  it('is asked signed in, once unanswered', () => {
    h.owner = 'user-1';
    useBodyMetricsStore.getState().addOrUpdate({ date: '2026-11-28', bodyFatPct: 18 });
    expect(h.asks).toBe(1);
  });

  it('is not asked for weight alone, or once answered', () => {
    h.owner = 'user-1';
    useBodyMetricsStore.getState().addOrUpdate({ date: '2026-11-28', weightKg: 80 });
    h.consent = 'refused';
    useBodyMetricsStore.getState().addOrUpdate({ date: '2026-11-29', bodyFatPct: 18 });
    expect(h.asks).toBe(0);
  });
});
