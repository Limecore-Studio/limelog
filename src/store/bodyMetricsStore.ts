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
import { reportWriteFailure } from '@/utils/storage';
import type { BodyMetric, BodyMetricsPrefs } from '@/types/bodyMetrics';
import { DEFAULT_PREFS } from '@/types/bodyMetrics';
import { enqueue } from '@/lib/outbox';
import { syncAllowed } from '@/lib/syncSetting';
import { healthConsent, requestHealthAsk, HEALTH_BODY_FIELDS } from '@/lib/healthConsent';
import { readOwner } from '@/lib/accountOwner';

const STORAGE_KEY = 'limelog-body-metrics';
const PREFS_KEY = 'limelog-body-metrics-prefs';
// v1.22 (limelog#124) - days deleted on this device. The recovery pull runs at
// every launch and sign-in, and can fetch a day before its queued delete has
// landed; without this it would put the deleted entry back. Cleared when the
// day is logged again, and by sign-out and erase with the other keys.
export const DELETED_KEY = 'limelog-body-metrics-deleted';

function loadDeleted(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveDeleted(dates: string[]): void {
  try {
    if (dates.length === 0) localStorage.removeItem(DELETED_KEY);
    else localStorage.setItem(DELETED_KEY, JSON.stringify(dates));
  } catch (e) {
    console.error('[bodyMetrics] deleted-days save failed:', e);
  }
}

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
    // v1.22 (limelog#127) — told, not silent: the weigh-in shows now but is
    // gone after a restart.
    reportWriteFailure(STORAGE_KEY, e);
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
  /** v1.22 (limelog#124) - add pulled cloud rows for days this device has no
   *  entry for (and did not delete). Local entries win; nothing is pushed.
   *  Returns how many were added. */
  recoverMetrics: (incoming: BodyMetric[]) => number;
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
      heightCm: input.heightCm ?? existing?.heightCm,
      bodyFatPct: input.bodyFatPct ?? existing?.bodyFatPct,
      waterPct: input.waterPct ?? existing?.waterPct,
      proteinPct: input.proteinPct ?? existing?.proteinPct,
      bmrKcal: input.bmrKcal ?? existing?.bmrKcal,
      visceralFat: input.visceralFat ?? existing?.visceralFat,
      boneMassKg: input.boneMassKg ?? existing?.boneMassKg,
      muscleMassKg: input.muscleMassKg ?? existing?.muscleMassKg,
      bodyAge: input.bodyAge ?? existing?.bodyAge,
      notes: input.notes ?? existing?.notes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? get().metrics.map((m) => (m.id === existing.id ? merged : m))
      : [...get().metrics, merged];
    saveToStorage(next);
    set({ metrics: next });
    const deleted = loadDeleted();
    if (deleted.includes(merged.date)) saveDeleted(deleted.filter((d) => d !== merged.date));
    // v1.22 (limecore#95) — queued only when sync is on, as workouts are. It
    // used to queue every save, so a guest's or a sync-off user's readings
    // went up with the next account to sign in or the next time sync was on.
    // v1.22 (limecore#91) — a body-composition reading synced for the first
    // time asks the health-data question; until it is answered the push
    // leaves those fields out (nexusSync.ts).
    // v1.22 (limelog#185) — signed in only: a guest never syncs, so there is
    // nothing to store on the server to ask about (syncAllowed() is true for
    // a guest too). The guest is asked after signing in, when the data is
    // found on the device (HealthConsentPrompt).
    if (readOwner() && syncAllowed() && healthConsent() === 'unasked' && HEALTH_BODY_FIELDS.some((f) => merged[f] !== undefined)) requestHealthAsk();
    if (syncAllowed()) enqueue('upsert_body_metric', {
      id: merged.id,
      date: merged.date,
      weightKg: merged.weightKg,
      chestCm: merged.chestCm,
      waistCm: merged.waistCm,
      hipsCm: merged.hipsCm,
      armsCm: merged.armsCm,
      legsCm: merged.legsCm,
      heightCm: merged.heightCm,
      bodyFatPct: merged.bodyFatPct,
      waterPct: merged.waterPct,
      proteinPct: merged.proteinPct,
      bmrKcal: merged.bmrKcal,
      visceralFat: merged.visceralFat,
      boneMassKg: merged.boneMassKg,
      muscleMassKg: merged.muscleMassKg,
      bodyAge: merged.bodyAge,
      notes: merged.notes,
    });
    return merged;
  },

  remove(id) {
    const gone = get().metrics.find((m) => m.id === id);
    const next = get().metrics.filter((m) => m.id !== id);
    saveToStorage(next);
    set({ metrics: next });
    const deleted = loadDeleted();
    if (gone && !deleted.includes(gone.date)) saveDeleted([...deleted, gone.date]);
    if (syncAllowed()) enqueue('delete_body_metric', { id, date: gone?.date });
  },

  recoverMetrics(incoming) {
    const skip = new Set([...get().metrics.map((m) => m.date), ...loadDeleted()]);
    const add: BodyMetric[] = [];
    for (const m of incoming) {
      if (skip.has(m.date)) continue;
      skip.add(m.date);
      add.push(m);
    }
    if (add.length === 0) return 0;
    const next = [...get().metrics, ...add];
    saveToStorage(next);
    set({ metrics: next });
    return add.length;
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
