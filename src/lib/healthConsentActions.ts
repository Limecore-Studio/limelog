// v1.22 (limecore#91) — what a yes or a withdrawal does (healthConsent.ts has
// the rules). Loaded on demand, from the prompt and Settings.
import { enqueue, cancel } from './outbox';
import { syncAllowed } from './syncSetting';
import { readOwner } from './accountOwner';
import { setHealthConsent, readHealthConsent, HEALTH_BODY_FIELDS } from './healthConsent';
import { writeHealthConsentToCloud } from './healthConsentCloud';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import { useLogStore } from '@/store/logStore';

/** Yes: recorded with its time (on the device, and on the account when signed
 *  in: healthConsentCloud.ts), and what was kept back is queued now. */
export function grantHealthConsent(): void {
  setHealthConsent(true);
  void writeHealthConsentToCloud(true, readHealthConsent()?.at ?? new Date().toISOString());
  requeueHealthData();
}

/** Queues the readings and debriefs held back while there was no consent. */
export function requeueHealthData(): void {
  cancel('clear_health_data', () => true);
  if (!syncAllowed()) return;
  for (const m of useBodyMetricsStore.getState().metrics) {
    if (!HEALTH_BODY_FIELDS.some((f) => m[f] !== undefined)) continue;
    enqueue('upsert_body_metric', {
      id: m.id,
      date: m.date,
      weightKg: m.weightKg,
      chestCm: m.chestCm,
      waistCm: m.waistCm,
      hipsCm: m.hipsCm,
      armsCm: m.armsCm,
      legsCm: m.legsCm,
      heightCm: m.heightCm,
      bodyFatPct: m.bodyFatPct,
      waterPct: m.waterPct,
      proteinPct: m.proteinPct,
      bmrKcal: m.bmrKcal,
      visceralFat: m.visceralFat,
      boneMassKg: m.boneMassKg,
      muscleMassKg: m.muscleMassKg,
      bodyAge: m.bodyAge,
      notes: m.notes,
    });
  }
  for (const l of useLogStore.getState().sessionLogs) {
    if (!l.finalizedAt || !(l.aiDebriefRaw || l.aiPainFlags?.length || l.aiNoteSummary)) continue;
    enqueue('upsert_session_debrief', {
      sessionId: l.id,
      aiDebriefRaw: l.aiDebriefRaw ?? null,
      aiPainFlags: l.aiPainFlags ?? null,
      aiNoteSummary: l.aiNoteSummary ?? null,
    });
  }
}

/** No (from the prompt): recorded; nothing was sent, so nothing to erase. */
export function refuseHealthConsent(): void {
  setHealthConsent(false);
  cancel('upsert_session_debrief', () => true);
}

/** Withdrawn in Settings: pushes stop carrying the data at once, and the
 *  server's copy is erased. The device keeps its own. Queued for the
 *  account even with sync switched off: erasing is not syncing. */
export function withdrawHealthConsent(): void {
  refuseHealthConsent();
  void writeHealthConsentToCloud(false, readHealthConsent()?.at ?? new Date().toISOString());
  if (readOwner()) enqueue('clear_health_data', {});
}
