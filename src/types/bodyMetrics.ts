// ── v1.2 Body Metrics types ───────────────────────────────────────────────
//
// One row per (user, date) representing the user's morning body snapshot:
// weight + any optional measurements they choose to track. Mirrors the
// Supabase `body_metrics` table shape.
//
// Units stored in SI (kg / cm) — display conversion (lbs / inches) is a
// client-side concern driven by `BodyMetricsPrefs.unitSystem`.
//
// Progress photos are deliberately NOT in this type — they're local-only
// (Capacitor Filesystem), keyed by date in a separate `body-photos` index
// in localStorage. Mixing them in here would force them into Supabase,
// which we're not doing for privacy reasons.

type UnitSystem = 'metric' | 'imperial';

export interface BodyMetric {
  /** UUID. Generated client-side; stable across sync. */
  id: string;
  /** YYYY-MM-DD local-time date this metric is FOR (not when it was logged). */
  date: string;
  /** All optional — the user picks which fields to track via prefs. */
  weightKg?: number;
  chestCm?: number;
  waistCm?: number;
  hipsCm?: number;
  armsCm?: number;
  legsCm?: number;
  // v1.19 (LL#104) — smart-scale readings and height. See lib/bodyScale.ts.
  heightCm?: number;
  bodyFatPct?: number;
  waterPct?: number;
  proteinPct?: number;
  bmrKcal?: number;
  visceralFat?: number;
  boneMassKg?: number;
  muscleMassKg?: number;
  bodyAge?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** Which measurements the user wants to surface in the logging UI. weight
 *  is always shown — it's the primary metric. The rest are opt-in to keep
 *  the form short for users who only care about bodyweight. */
export interface BodyMetricsPrefs {
  unitSystem: UnitSystem;
  trackChest: boolean;
  trackWaist: boolean;
  trackHips: boolean;
  trackArms: boolean;
  trackLegs: boolean;
  /** v1.19 (LL#104) — show the smart-scale fields in the log form. */
  trackScale: boolean;
}

export const DEFAULT_PREFS: BodyMetricsPrefs = {
  unitSystem: 'metric',
  trackChest: false,
  trackWaist: false,
  trackHips: false,
  trackArms: false,
  trackLegs: false,
  trackScale: false,
};

// ── Unit conversion ────────────────────────────────────────────────────────

export function kgToLb(kg: number): number {
  return kg * 2.2046226218;
}
export function lbToKg(lb: number): number {
  return lb / 2.2046226218;
}
export function cmToIn(cm: number): number {
  return cm / 2.54;
}
export function inToCm(inch: number): number {
  return inch * 2.54;
}

export function formatWeight(kg: number | undefined, sys: UnitSystem): string {
  if (kg == null) return '—';
  if (sys === 'imperial') return `${kgToLb(kg).toFixed(1)} lb`;
  return `${kg.toFixed(1)} kg`;
}

export function formatLength(cm: number | undefined, sys: UnitSystem): string {
  if (cm == null) return '—';
  if (sys === 'imperial') return `${cmToIn(cm).toFixed(1)}"`;
  return `${cm.toFixed(1)} cm`;
}
