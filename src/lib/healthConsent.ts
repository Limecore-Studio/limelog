// v1.22 (limecore#91, GDPR Art. 9(2)(a)) — explicit consent for health data.
//
// Owner decision: special-category data syncs only after a one-time yes.
//   - What counts: the smart-scale body-composition readings (body fat %,
//     water %, protein %, BMR, visceral fat, bone and muscle mass, body age)
//     and the AI debrief's pain content (the note, the pain flags and the
//     summary, which can repeat the note). Weight, girths and height are not
//     special-category data and sync as before.
//   - Not asked, or declined: they stay on the device. Pushes leave them out
//     (nexusSync.ts filters at send time, so items queued before this version
//     are covered too) and the debrief note is not sent to AI.
//   - Yes: the readings and debriefs already on the device are queued
//     (requeueHealthData).
//   - Withdrawn in Settings: pushes stop carrying them, and a queued
//     `clear_health_data` erases them from the server (the columns are set to
//     null; the rows, with weight and the workout itself, stay). Kept on the
//     device, as the privacy policy says.
//
// The answer, with its time, belongs to the account or the guest, like the
// other consents (consent.ts): `limelog.healthConsent.<owner>`. An erase
// removes it with every `limelog.` key. Device-only for now: another device
// of the same account asks again (a user_preferences column would carry it;
// that is a migration, so it is written up separately).
import { readOwner } from './accountOwner';

export type HealthConsent = 'granted' | 'refused' | 'unasked';
interface Record_ {
  granted: boolean;
  at: string;
}

const PREFIX = 'limelog.healthConsent.';
const listeners = new Set<() => void>();

export function healthOwner(): string {
  return readOwner() ?? 'guest';
}

export function readHealthConsent(owner = healthOwner()): Record_ | null {
  try {
    const v = JSON.parse(localStorage.getItem(PREFIX + owner) ?? 'null');
    return v && typeof v.granted === 'boolean' && typeof v.at === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function healthConsent(owner = healthOwner()): HealthConsent {
  const r = readHealthConsent(owner);
  return r ? (r.granted ? 'granted' : 'refused') : 'unasked';
}

/** True only for an explicit yes. */
export function healthAllowed(owner = healthOwner()): boolean {
  return healthConsent(owner) === 'granted';
}

export function setHealthConsent(granted: boolean, owner = healthOwner(), now = new Date()): void {
  try {
    localStorage.setItem(PREFIX + owner, JSON.stringify({ granted, at: now.toISOString() }));
  } catch {
    /* storage refused: not kept, so nothing is synced */
  }
  listeners.forEach((l) => l());
}

export function subscribeHealthConsent(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The body_metrics columns that are health data. */
export const HEALTH_BODY_COLUMNS = ['body_fat_pct', 'water_pct', 'protein_pct', 'bmr_kcal', 'visceral_fat', 'bone_mass_kg', 'muscle_mass_kg', 'body_age'] as const;
/** The workout_sessions columns that are health data. */
export const HEALTH_SESSION_COLUMNS = ['ai_debrief_raw', 'ai_pain_flags', 'ai_note_summary'] as const;

/** The local fields behind HEALTH_BODY_COLUMNS. */
export const HEALTH_BODY_FIELDS = ['bodyFatPct', 'waterPct', 'proteinPct', 'bmrKcal', 'visceralFat', 'boneMassKg', 'muscleMassKg', 'bodyAge'] as const;

/** Asks the prompt to show (HealthConsentPrompt), when health data was just
 *  recorded or the debrief needs the answer. */
export const HEALTH_ASK_EVENT = 'limelog:health-ask';
export function requestHealthAsk(): void {
  try {
    window.dispatchEvent(new CustomEvent(HEALTH_ASK_EVENT));
  } catch {
    /* no window (tests) */
  }
}
