// v1.22 (limecore#91, #135) — the health-data consent on the account, so it
// can be shown that consent was given (Art. 7(1)) and other devices follow it.
//
// `user_preferences.health_consent_at` / `health_consent_withdrawn_at`
// (limecore#135). Only these two columns and the key are written, so another
// app's preference columns are never touched. The device copy
// (healthConsent.ts) stays the source for guests and when offline. Until the
// migration is applied the columns are missing (PGRST204 / 42703): that is
// logged and the app carries on with the device copy. Loaded on demand.
import { supabase, isNexusConfigured } from './supabase';
import { readOwner } from './accountOwner';
import { readHealthConsent, setHealthConsent, healthOwner } from './healthConsent';

const MISSING = new Set(['PGRST204', '42703']);

function signedInOwner(): string | null {
  if (!isNexusConfigured) return null;
  const owner = readOwner();
  return owner && owner === healthOwner() ? owner : null;
}

/** Records a yes (granted) or a withdrawal on the account. Best-effort. */
export async function writeHealthConsentToCloud(granted: boolean, at: string): Promise<void> {
  const userId = signedInOwner();
  if (!userId) return;
  const row: Record<string, string | null> = granted
    ? { user_id: userId, health_consent_at: at, health_consent_withdrawn_at: null }
    : { user_id: userId, health_consent_withdrawn_at: at };
  try {
    const { error } = await supabase.from('user_preferences').upsert(row, { onConflict: 'user_id' });
    if (error && MISSING.has(error.code ?? '')) console.info('[health] consent columns not there yet (limecore#135); kept on the device');
    else if (error) console.warn('[health] consent write failed:', error.message);
  } catch (e) {
    console.warn('[health] consent write threw:', (e as Error).message);
  }
}

/** Adopts the account's answer when it is newer than this device's, so a yes
 *  or a withdrawal on another device applies here. Returns whether the
 *  account had an answer. */
export async function readHealthConsentFromCloud(): Promise<boolean> {
  const userId = signedInOwner();
  if (!userId) return false;
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('health_consent_at, health_consent_withdrawn_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (!MISSING.has(error.code ?? '')) console.warn('[health] consent read failed:', error.message);
      return false;
    }
    const given = data?.health_consent_at ? Date.parse(data.health_consent_at) : NaN;
    const withdrawn = data?.health_consent_withdrawn_at ? Date.parse(data.health_consent_withdrawn_at) : NaN;
    if (!Number.isFinite(given) && !Number.isFinite(withdrawn)) return false;
    const granted = Number.isFinite(given) && !(withdrawn >= given);
    const at = granted ? given : withdrawn;
    const local = readHealthConsent();
    if (!local || Date.parse(local.at) < at) setHealthConsent(granted, healthOwner(), new Date(at));
    return true;
  } catch {
    return false;
  }
}
