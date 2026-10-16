import { kgToLb } from '@/types/bodyMetrics';
import i18n from '@/i18n';

export function generateId(): string {
  return crypto.randomUUID();
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

// Lift weights. The conversion itself lives in types/bodyMetrics.ts. This
// module used to carry its own kgToLb/lbToKg on a truncated 2.2046 that also
// rounded *inside* the conversion, so lbToKg(kgToLb(x)) !== x. Rounding belongs
// at the display boundary, once — and only one constant should exist.

/** A lift weight in the user's chosen unit, rounded for display.
 *  For call sites that render their own unit label (charts, table rows). */
export function toDisplayWeight(kg: number, unit: 'kg' | 'lb'): number {
  return Math.round((unit === 'lb' ? kgToLb(kg) : kg) * 10) / 10;
}

/** A lift weight in the user's chosen unit, with the unit label. */
export function formatWeight(kg: number, unit: 'kg' | 'lb'): string {
  return `${toDisplayWeight(kg, unit)} ${unit}`;
}

// ── Cardio (v1.9 Item 4) ───────────────────────────────────────────────────

/**
 * A duration in whole seconds as a compact string: "45 min", "1 h 12 min".
 *
 * Under an hour the hour part is dropped rather than rendered as "0 h", and on
 * the hour the minutes are dropped rather than "1 h 0 min" — a stopwatch
 * reading is not a clock, and the zero units are noise.
 */
export function formatDuration(seconds: number): string {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * A distance in metres, rendered in the user's system.
 *
 * Deliberately no separate distance preference: `unitPreference` already
 * records metric vs imperial for weight, and someone who thinks in pounds
 * thinks in miles. A second toggle would let the two disagree, which is a
 * setting nobody wants to own.
 */
export function formatDistance(meters: number, unit: 'kg' | 'lb'): string {
  if (unit === 'lb') return `${Math.round((meters / 1609.344) * 100) / 100} mi`;
  return `${Math.round((meters / 1000) * 100) / 100} km`;
}

// ── Locale-aware dates ─────────────────────────────────────────────────────

/** The formatting locale, deliberately not the same value as the i18n resource
 *  language. i18n resolves to a bare code ('en'); the device reports a region
 *  ('en-GB', 'en-IN', 'pt-BR'). When the two agree on language, prefer the
 *  device's regional tag so a UK user keeps "26 Jul" and a US user gets
 *  "Jul 26" — both reading the same English strings. When the user has picked a
 *  language that differs from the device, the region no longer applies. */
function formatLocale(): string {
  const lang = (i18n.language || 'en').split('-')[0];
  const nav = (typeof navigator !== 'undefined'
    && (navigator.languages?.[0] || navigator.language)) || '';
  return nav.split('-')[0] === lang ? nav : lang;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(formatLocale(), {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

/** A clock time in the app's language (v1.18.1, LimeLog#77): a bare
 *  toLocaleTimeString() follows the device, not the language the user chose. */
export function formatTime(when: string | number | Date): string {
  return new Date(when).toLocaleTimeString(formatLocale());
}

/** Localised weekday names, indexed 0 = Sunday to match Date.getDay() and the
 *  dayOfWeek fields stored on session templates.
 *
 *  Built from a known week (2024-01-07 was a Sunday) rather than a hardcoded
 *  list, so every locale — including ar, hi and zh — gets correct names for
 *  free. Computed per call: the language can change at runtime. */
export function weekdayNames(style: 'long' | 'short' | 'narrow'): string[] {
  const fmt = new Intl.DateTimeFormat(formatLocale(), { weekday: style });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i)));
}

export function getDayOfWeek(): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return new Date().getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

