import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient } from '../test/fakePostgrest';
import type { BodyMetric } from '@/types/bodyMetrics';

// v1.22 (limelog#124) — body_metrics was never pulled back, so after a sign-out
// and back in, a reinstall or a new phone the Body page was empty while NCC
// still showed the history. The real pull and the real store; the Supabase
// client is the shared read-side fake, and the outbox is a spy.

const USER = 'user-1';
const holder = vi.hoisted(() => ({ client: null as unknown }));
const enqueue = vi.fn();
vi.mock('./supabase', () => ({
  isNexusConfigured: true,
  get supabase() {
    return holder.client;
  },
}));
vi.mock('./outbox', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
vi.stubGlobal('localStorage', storage());
const { pullBodyMetricsFromCloud } = await import('./nexusRecovery');
const { useBodyMetricsStore, DELETED_KEY } = await import('@/store/bodyMetricsStore');
const store = () => useBodyMetricsStore.getState();

function client(rows: Record<string, unknown>[], signedIn = USER) {
  const base = fakeClient({ body_metrics: rows });
  return { ...base, auth: { getUser: async () => ({ data: { user: { id: signedIn } }, error: null }) } };
}

const cloudRow = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id, user_id: USER, date, weight_kg: 80, chest_cm: null, waist_cm: '82.5', hips_cm: null, arms_cm: null,
  legs_cm: null, height_cm: null, body_fat_pct: '18.4', water_pct: null, protein_pct: null, bmr_kcal: 1800,
  visceral_fat: null, bone_mass_kg: null, muscle_mass_kg: null, body_age: null, notes: null,
  created_at: `${date}T07:00:00Z`, updated_at: `${date}T07:00:00Z`, ...over,
});

const local = (date: string, weightKg: number): BodyMetric => ({
  id: `local-${date}`, date, weightKg, createdAt: `${date}T07:00:00Z`, updatedAt: `${date}T07:00:00Z`,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  enqueue.mockClear();
  useBodyMetricsStore.setState({ metrics: [] });
});

describe('pullBodyMetricsFromCloud', () => {
  it('returns the account’s rows mapped to entries, numerics as numbers, nulls left out', async () => {
    holder.client = client([cloudRow('a', '2026-11-01'), { ...cloudRow('x', '2026-11-02'), user_id: 'someone-else' }]);
    const rows = await pullBodyMetricsFromCloud(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', date: '2026-11-01', weightKg: 80, waistCm: 82.5, bodyFatPct: 18.4, bmrKcal: 1800 });
    expect(rows[0]).not.toHaveProperty('chestCm', null);
    expect(rows[0].chestCm).toBeUndefined();
  });

  it('refuses when another account is signed in by the time it runs', async () => {
    holder.client = client([cloudRow('a', '2026-11-01')], 'user-2');
    await expect(pullBodyMetricsFromCloud(USER)).rejects.toThrow();
  });
});

describe('recoverMetrics', () => {
  it('restores every day after a reinstall, and pushes nothing back', async () => {
    holder.client = client([cloudRow('a', '2026-11-01'), cloudRow('b', '2026-11-08', { weight_kg: 79 })]);
    expect(store().recoverMetrics(await pullBodyMetricsFromCloud(USER))).toBe(2);
    expect(store().latestWeight()).toBe(79);
    expect(JSON.parse(localStorage.getItem('limelog-body-metrics')!)).toHaveLength(2);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps the local entry for a day the device already has', () => {
    useBodyMetricsStore.setState({ metrics: [local('2026-11-01', 81)] });
    expect(store().recoverMetrics([{ ...local('2026-11-01', 80), id: 'cloud' }])).toBe(0);
    expect(store().metrics).toEqual([local('2026-11-01', 81)]);
  });

  it('does not bring back a day deleted here, until it is logged again', () => {
    useBodyMetricsStore.setState({ metrics: [local('2026-11-01', 81)] });
    store().remove('local-2026-11-01');
    expect(store().recoverMetrics([local('2026-11-01', 81)])).toBe(0);
    store().addOrUpdate({ date: '2026-11-01', weightKg: 82 });
    expect(localStorage.getItem(DELETED_KEY)).toBeNull();
  });

  it('a second pull adds nothing', () => {
    store().recoverMetrics([local('2026-11-01', 81)]);
    expect(store().recoverMetrics([local('2026-11-01', 81)])).toBe(0);
  });
});
