// ── v1.2 Body Metrics Zustand store ───────────────────────────────────────
//
// localStorage-persisted. One row per (id) with logical uniqueness on
// (date) — addOrUpdate folds same-day entries into one row so the UI
// doesn't accidentally create duplicates.
//
// On every mutation:
//   1. Persist to localStorage immediately.
//   2. Enqueue the corresponding outbox kind so the change syncs upstream
//      when Nexus is configured. The outbox tolerates offline + unsigned-in
//      states; nothing here blocks on the network.

import { create } from 'zustand';
import type { BodyMetric, BodyMetricsPrefs } from '@/types/bodyMetrics';
import { DEFAULT_PREFS } from '@/types/bodyMetrics';
import { enqueue } from '@/lib/outbox';

const STORAGE_KEY = 'limelog-body-metrics';
const PREFS_KEY = 'limelog-body-metrics-prefs';

function loadFromStorage(): BodyMetric[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveToStorage(rows: BodyMetric[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch (e) {
    console.error('[bodyMetrics] save failed:', e);
  }
}

function loadPrefs(): BodyMetricsPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: BodyMetricsPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.error('[bodyMetrics] prefs save failed:', e);
  }
}

interface BodyMetricsStore {
  metrics: BodyMetric[];
  prefs: BodyMetricsPrefs;

  /** Upsert by date — folds same-day entries into one row. Returns the row
   *  that landed (for the UI to scroll to / highlight). */
  addOrUpdate: (
    input: Omit<BodyMetric, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ) => BodyMetric;
  remove: (id: string) => void;
  updatePrefs: (patch: Partial<BodyMetricsPrefs>) => void;

  // ── Selectors ────────────────────────────────────────────────────────
  /** Latest entry that has a weight value, or null. */
  latestWeight: () => number | null;
  /** Most-recent first. */
  sortedByDate: () => BodyMetric[];
}

export const useBodyMetricsStore = create<BodyMetricsStore>((set, get) => ({
  metrics: loadFromStorage(),
  prefs: loadPrefs(),

  addOrUpdate(input) {
    const now = new Date().toISOString();
    const existing = get().metrics.find((m) => m.date === input.date);
    const id = input.id ?? existing?.id ?? crypto.randomUUID();
    // Merge: existing fields stay unless explicitly overwritten, so updating
    // "weight only" doesn't blow away yesterday-evening's measurements.
    const merged: BodyMetric = {
      id,
      date: input.date,
      weightKg: input.weightKg ?? existing?.weightKg,
      chestCm: input.chestCm ?? existing?.chestCm,
      waistCm: input.waistCm ?? existing?.waistCm,
      hipsCm: input.hipsCm ?? existing?.hipsCm,
      armsCm: input.armsCm ?? existing?.armsCm,
      legsCm: input.legsCm ?? existing?.legsCm,
      notes: input.notes ?? existing?.notes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? get().metrics.map((m) => (m.id === existing.id ? merged : m))
      : [...get().metrics, merged];
    saveToStorage(next);
    set({ metrics: next });
    enqueue('upsert_body_metric', {
      id: merged.id,
      date: merged.date,
      weightKg: merged.weightKg,
      chestCm: merged.chestCm,
      waistCm: merged.waistCm,
      hipsCm: merged.hipsCm,
      armsCm: merged.armsCm,
      legsCm: merged.legsCm,
      notes: merged.notes,
    });
    return merged;
  },

  remove(id) {
    const gone = get().metrics.find((m) => m.id === id);
    const next = get().metrics.filter((m) => m.id !== id);
    saveToStorage(next);
    set({ metrics: next });
    enqueue('delete_body_metric', { id, date: gone?.date });
  },

  updatePrefs(patch) {
    const next = { ...get().prefs, ...patch };
    savePrefs(next);
    set({ prefs: next });
  },

  latestWeight() {
    const rows = get().metrics.filter((m) => m.weightKg != null);
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => (a.date > b.date ? -1 : 1));
    return sorted[0].weightKg ?? null;
  },

  sortedByDate() {
    return [...get().metrics].sort((a, b) => (a.date > b.date ? -1 : 1));
  },
}));
