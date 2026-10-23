// v1.19 (LL#104) — smart-scale metrics, height, and BMI.
//
// From the Discord backlog: log more than weight (what a smart scale shows),
// "I can't find anywhere to set height", and a height LOG rather than one
// setting, because some users are still growing.
//
// ── Where they live ───────────────────────────────────────────────────────
// In the `body_metrics` row for the day, next to weight and the girths: nine
// nullable columns, added additively (supabase/migrations/
// 20261023_body_metrics_scale.sql). Not a second table: body data is already
// one row per (user, date), NCC already reads that table, and a parallel
// `metric/value` table would be the "second, divergent schema" the issue
// warns against. A height log is then simply the days that have a height.
//
// ── Bounds ────────────────────────────────────────────────────────────────
// Each column has a CHECK with the bounds below, and the form refuses the
// same values. They must match: a value the server refuses would sit in the
// outbox retrying for ever (the lesson of StudyDesk#71). They are wide on
// purpose — a scale's reading for a child or a heavyweight is still a reading.
//
// BMI is calculated, never stored and never entered.

import type { BodyMetric } from '@/types/bodyMetrics';
import { kgToLb, lbToKg } from '@/types/bodyMetrics';

export type ScaleKind = 'pct' | 'kcal' | 'level' | 'mass' | 'years';

export interface ScaleSpec {
  key: ScaleKey;
  labelKey: string;
  kind: ScaleKind;
  /** Stored units: % / kcal / level / kg / years. */
  min: number;
  max: number;
  step: number;
}

export type ScaleKey =
  | 'bodyFatPct' | 'waterPct' | 'proteinPct' | 'bmrKcal'
  | 'visceralFat' | 'boneMassKg' | 'muscleMassKg' | 'bodyAge';

export const SCALE_METRICS: readonly ScaleSpec[] = [
  { key: 'bodyFatPct', labelKey: 'body.scale.bodyFat', kind: 'pct', min: 1, max: 75, step: 0.1 },
  { key: 'waterPct', labelKey: 'body.scale.water', kind: 'pct', min: 20, max: 80, step: 0.1 },
  { key: 'proteinPct', labelKey: 'body.scale.protein', kind: 'pct', min: 5, max: 40, step: 0.1 },
  { key: 'bmrKcal', labelKey: 'body.scale.bmr', kind: 'kcal', min: 500, max: 5000, step: 1 },
  { key: 'visceralFat', labelKey: 'body.scale.visceral', kind: 'level', min: 1, max: 60, step: 0.5 },
  { key: 'boneMassKg', labelKey: 'body.scale.bone', kind: 'mass', min: 0.5, max: 10, step: 0.1 },
  { key: 'muscleMassKg', labelKey: 'body.scale.muscle', kind: 'mass', min: 5, max: 150, step: 0.1 },
  { key: 'bodyAge', labelKey: 'body.scale.bodyAge', kind: 'years', min: 5, max: 120, step: 1 },
];

/** Height bounds in cm (the column CHECK uses the same). */
export const HEIGHT_MIN_CM = 40;
export const HEIGHT_MAX_CM = 272;

type UnitSystem = 'metric' | 'imperial';

/** The unit a metric is typed and shown in. Mass follows kg/lb; the rest have none to choose. */
export function scaleUnit(spec: ScaleSpec, sys: UnitSystem): string {
  switch (spec.kind) {
    case 'pct': return '%';
    case 'kcal': return 'kcal';
    case 'mass': return sys === 'imperial' ? 'lb' : 'kg';
    default: return '';
  }
}

/**
 * Typed text → stored value, or undefined for an empty or unusable field,
 * or null when it is a number but outside the bounds (the form says so).
 */
export function parseScaleInput(spec: ScaleSpec, input: string, sys: UnitSystem): number | undefined | null {
  if (!input.trim()) return undefined;
  const n = parseFloat(input.replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  const stored = spec.kind === 'mass' && sys === 'imperial' ? lbToKg(n) : n;
  const rounded = spec.step >= 1 ? Math.round(stored) : Math.round(stored * 100) / 100;
  return rounded < spec.min || rounded > spec.max ? null : rounded;
}

/** Stored value → the text a field shows. */
export function scaleToInput(spec: ScaleSpec, v: number | undefined, sys: UnitSystem): string {
  if (v == null) return '';
  const shown = spec.kind === 'mass' && sys === 'imperial' ? kgToLb(v) : v;
  return spec.step >= 1 ? String(Math.round(shown)) : String(Math.round(shown * 10) / 10);
}

export function formatScale(spec: ScaleSpec, v: number | undefined, sys: UnitSystem): string {
  if (v == null) return '—';
  const unit = scaleUnit(spec, sys);
  const text = scaleToInput(spec, v, sys);
  return unit === '%' ? `${text}%` : unit ? `${text} ${unit}` : text;
}

// ── Height ───────────────────────────────────────────────────────────────

/** Typed height → cm. Metric: one cm field. Imperial: feet and inches. */
export function parseHeight(sys: UnitSystem, a: string, b = ''): number | undefined | null {
  let cm: number;
  if (sys === 'imperial') {
    const ft = a.trim() ? parseFloat(a) : 0;
    const inch = b.trim() ? parseFloat(b.replace(',', '.')) : 0;
    if (!a.trim() && !b.trim()) return undefined;
    if (!Number.isFinite(ft) || !Number.isFinite(inch)) return undefined;
    cm = (ft * 12 + inch) * 2.54;
  } else {
    if (!a.trim()) return undefined;
    cm = parseFloat(a.replace(',', '.'));
    if (!Number.isFinite(cm)) return undefined;
  }
  cm = Math.round(cm * 10) / 10;
  return cm < HEIGHT_MIN_CM || cm > HEIGHT_MAX_CM ? null : cm;
}

/** "178 cm" or "5′10″". */
export function formatHeight(cm: number | undefined, sys: UnitSystem): string {
  if (cm == null) return '—';
  if (sys === 'metric') return `${Math.round(cm * 10) / 10} cm`;
  const totalIn = Math.round(cm / 2.54);
  return `${Math.floor(totalIn / 12)}′${totalIn % 12}″`;
}

const byDate = (a: BodyMetric, b: BodyMetric) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** The days with a height, oldest first. */
export function heightSeries(metrics: BodyMetric[]): { date: string; value: number }[] {
  return metrics.filter((m) => m.heightCm != null).sort(byDate).map((m) => ({ date: m.date, value: m.heightCm! }));
}

/** The days with this scale metric, oldest first. */
export function scaleSeries(metrics: BodyMetric[], key: ScaleKey): { date: string; value: number }[] {
  return metrics.filter((m) => m[key] != null).sort(byDate).map((m) => ({ date: m.date, value: m[key]! }));
}

/**
 * The height that applied on `date`: the latest measured on or before it.
 * Only when nothing was measured that early does it take the first height
 * measured after — someone who starts tracking height today still gets a BMI
 * for this morning's weight.
 */
export function heightOn(metrics: BodyMetric[], date: string): number | null {
  const hs = heightSeries(metrics);
  if (!hs.length) return null;
  let at: number | null = null;
  for (const h of hs) if (h.date <= date) at = h.value;
  return at ?? hs[0].value;
}

/**
 * BMI from the latest weight and the height that applied on that weight's
 * day (not the latest height: a growing user's old weights keep their own
 * BMI). Null without both.
 */
export function latestBmi(metrics: BodyMetric[]): { bmi: number; date: string } | null {
  const weights = metrics.filter((m) => m.weightKg != null).sort(byDate);
  const w = weights[weights.length - 1];
  if (!w) return null;
  const h = heightOn(metrics, w.date);
  if (!h) return null;
  const m = h / 100;
  return { bmi: Math.round((w.weightKg! / (m * m)) * 10) / 10, date: w.date };
}
